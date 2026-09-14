import net from "node:net";
import tls from "node:tls";
import dns from "node:dns/promises";

export interface ProbeOutcome {
  statusCode: number;
  dnsMs: number;
  tcpMs: number;
  tlsMs: number;
  ttfbMs: number;
  totalMs: number;
  sslDaysRemaining: number | null;
  sslValid: boolean;
  finalUrl: string;
  redirectCount: number;
  errorMessage?: string;
}

const REDIRECT_STATUS_CODES = new Set([301, 302, 303, 307, 308]);

// In-Memory DNS Cache (60s TTL)
const dnsCache = new Map<string, { address: string; expiresAt: number }>();

// In-Memory SSL Cert Cache (1 Hour TTL)
const sslCache = new Map<string, { sslDaysRemaining: number | null; sslValid: boolean; expiresAt: number }>();

// Connection Keep-Alive Pool (Reuses TCP/TLS connections for sub-50ms warm probes)
interface PooledSocket {
  socket: any;
  hostname: string;
  isHttps: boolean;
  sslDaysRemaining: number | null;
  sslValid: boolean;
  expiresAt: number;
}
const socketPool = new Map<string, PooledSocket>();

async function resolveDnsFast(hostname: string): Promise<{ address: string; dnsMs: number }> {
  if (net.isIP(hostname) !== 0) {
    return { address: hostname, dnsMs: 0 };
  }

  const cached = dnsCache.get(hostname);
  if (cached && cached.expiresAt > Date.now()) {
    return { address: cached.address, dnsMs: 0 };
  }

  const dnsStart = process.hrtime.bigint();
  const lookup = await dns.lookup(hostname);
  const dnsMs = Number((process.hrtime.bigint() - dnsStart) / 1_000_000n);

  dnsCache.set(hostname, { address: lookup.address, expiresAt: Date.now() + 60_000 });
  return { address: lookup.address, dnsMs };
}

function normalizeUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim();
  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed;
  }
  return `https://${trimmed}`;
}

export async function probeEndpoint(
  rawUrl: string,
  timeoutMs = 10000,
  maxRedirects = 3
): Promise<ProbeOutcome> {
  const initialUrl = normalizeUrl(rawUrl);
  const overallStart = process.hrtime.bigint();

  return executeHop(initialUrl, overallStart, timeoutMs, maxRedirects, 0);
}

async function executeHop(
  targetUrl: string,
  overallStart: bigint,
  timeoutMs: number,
  redirectsLeft: number,
  hopsDone: number
): Promise<ProbeOutcome> {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(targetUrl);
  } catch (err: any) {
    const now = process.hrtime.bigint();
    return {
      statusCode: 0,
      dnsMs: 0,
      tcpMs: 0,
      tlsMs: 0,
      ttfbMs: 0,
      totalMs: Number((now - overallStart) / 1_000_000n),
      sslDaysRemaining: null,
      sslValid: false,
      finalUrl: targetUrl,
      redirectCount: hopsDone,
      errorMessage: `Invalid URL: ${err.message}`,
    };
  }

  const hostname = parsedUrl.hostname;
  const isHttps = parsedUrl.protocol === "https:";
  const port = Number(parsedUrl.port) || (isHttps ? 443 : 80);
  const poolKey = `${parsedUrl.protocol}//${hostname}:${port}`;

  // 1. Fast DNS Phase (Cached)
  let dnsMs = 0;
  let ipAddress = hostname;
  try {
    const dnsResult = await resolveDnsFast(hostname);
    ipAddress = dnsResult.address;
    dnsMs = dnsResult.dnsMs;
  } catch (dnsErr: any) {
    const failEnd = process.hrtime.bigint();
    return {
      statusCode: 0,
      dnsMs: 0,
      tcpMs: 0,
      tlsMs: 0,
      ttfbMs: 0,
      totalMs: Number((failEnd - overallStart) / 1_000_000n),
      sslDaysRemaining: null,
      sslValid: false,
      finalUrl: parsedUrl.toString(),
      redirectCount: hopsDone,
      errorMessage: `DNS Lookup failed: ${dnsErr.message}`,
    };
  }

  // 2. Check Keep-Alive Socket Pool for Sub-50ms Warm Connection
  const pooled = socketPool.get(poolKey);
  if (pooled && pooled.expiresAt > Date.now() && !pooled.socket.destroyed) {
    socketPool.delete(poolKey); // Remove from pool while in active use
    return probeOnExistingSocket(
      pooled.socket,
      parsedUrl,
      overallStart,
      timeoutMs,
      redirectsLeft,
      hopsDone,
      poolKey,
      pooled.sslDaysRemaining,
      pooled.sslValid
    );
  }

  // Cold Connection Setup
  const elapsedMs = Number((process.hrtime.bigint() - overallStart) / 1_000_000n);
  const hopTimeout = Math.max(500, timeoutMs - elapsedMs);

  return new Promise((resolve) => {
    let timer: any;
    let resolved = false;

    let tcpStart = 0n;
    let tcpEnd = 0n;
    let tcpMs = 0;

    let tlsStart = 0n;
    let tlsEnd = 0n;
    let tlsMs = 0;

    let sslDaysRemaining: number | null = null;
    let sslValid = isHttps;
    let sslError: string | undefined;

    const cleanup = () => {
      if (timer) clearTimeout(timer);
    };

    timer = setTimeout(() => {
      if (resolved) return;
      resolved = true;
      const now = process.hrtime.bigint();
      resolve({
        statusCode: 0,
        dnsMs,
        tcpMs,
        tlsMs,
        ttfbMs: 0,
        totalMs: Number((now - overallStart) / 1_000_000n),
        sslDaysRemaining: null,
        sslValid: false,
        finalUrl: parsedUrl.toString(),
        redirectCount: hopsDone,
        errorMessage: `Connection timed out after ${hopTimeout}ms`,
      });
    }, hopTimeout);

    // TCP Connection
    tcpStart = process.hrtime.bigint();
    const rawSocket = net.createConnection({ host: ipAddress, port }, () => {
      tcpEnd = process.hrtime.bigint();
      tcpMs = Number((tcpEnd - tcpStart) / 1_000_000n);

      if (isHttps) {
        tlsStart = process.hrtime.bigint();
        const secureSocket = tls.connect(
          {
            socket: rawSocket,
            servername: net.isIP(hostname) ? undefined : hostname,
            rejectUnauthorized: false,
          },
          () => {
            tlsEnd = process.hrtime.bigint();
            tlsMs = Number((tlsEnd - tlsStart) / 1_000_000n);

            // SSL Cert Inspection (Cached for 1 hour)
            const cachedSsl = sslCache.get(hostname);
            if (cachedSsl && cachedSsl.expiresAt > Date.now()) {
              sslDaysRemaining = cachedSsl.sslDaysRemaining;
              sslValid = cachedSsl.sslValid;
            } else {
              const cert = secureSocket.getPeerCertificate();
              if (secureSocket.authorized === false) {
                sslValid = false;
                sslError = secureSocket.authorizationError
                  ? String(secureSocket.authorizationError)
                  : "SSL Certificate is not trusted";
              }

              if (cert && cert.valid_to) {
                const expiryDate = new Date(cert.valid_to).getTime();
                const msRemaining = expiryDate - Date.now();
                sslDaysRemaining = Math.floor(msRemaining / (1000 * 60 * 60 * 24));
                if (msRemaining <= 0) sslValid = false;
              } else {
                sslValid = false;
                sslDaysRemaining = null;
              }

              sslCache.set(hostname, {
                sslDaysRemaining,
                sslValid,
                expiresAt: Date.now() + 3600_000,
              });
            }

            dispatchHttpRequest(
              secureSocket,
              parsedUrl,
              overallStart,
              timeoutMs,
              redirectsLeft,
              hopsDone,
              dnsMs,
              tcpMs,
              tlsMs,
              sslDaysRemaining,
              sslValid,
              sslError,
              poolKey,
              cleanup,
              (res) => {
                if (!resolved) {
                  resolved = true;
                  resolve(res);
                }
              }
            );
          }
        );

        secureSocket.on("error", (err: any) => {
          if (resolved) return;
          resolved = true;
          cleanup();
          resolve({
            statusCode: 0,
            dnsMs,
            tcpMs,
            tlsMs: 0,
            ttfbMs: 0,
            totalMs: Number((process.hrtime.bigint() - overallStart) / 1_000_000n),
            sslDaysRemaining: null,
            sslValid: false,
            finalUrl: parsedUrl.toString(),
            redirectCount: hopsDone,
            errorMessage: err.message || "TLS connection failed",
          });
        });
      } else {
        dispatchHttpRequest(
          rawSocket,
          parsedUrl,
          overallStart,
          timeoutMs,
          redirectsLeft,
          hopsDone,
          dnsMs,
          tcpMs,
          0,
          null,
          true,
          undefined,
          poolKey,
          cleanup,
          (res) => {
            if (!resolved) {
              resolved = true;
              resolve(res);
            }
          }
        );
      }
    });

    rawSocket.on("error", (err: any) => {
      if (resolved) return;
      resolved = true;
      cleanup();
      resolve({
        statusCode: 0,
        dnsMs,
        tcpMs: 0,
        tlsMs: 0,
        ttfbMs: 0,
        totalMs: Number((process.hrtime.bigint() - overallStart) / 1_000_000n),
        sslDaysRemaining: null,
        sslValid: false,
        finalUrl: parsedUrl.toString(),
        redirectCount: hopsDone,
        errorMessage: err.message || "TCP connection failed",
      });
    });
  });
}

/**
 * Dispatch HTTP request over a newly opened socket or pooled socket
 */
function dispatchHttpRequest(
  socket: any,
  parsedUrl: URL,
  overallStart: bigint,
  timeoutMs: number,
  redirectsLeft: number,
  hopsDone: number,
  dnsMs: number,
  tcpMs: number,
  tlsMs: number,
  sslDaysRemaining: number | null,
  sslValid: boolean,
  sslError: string | undefined,
  poolKey: string,
  cleanup: () => void,
  resolve: (res: ProbeOutcome) => void
) {
  const ttfbStart = process.hrtime.bigint();
  let responseData = "";
  let firstByteReceived = false;
  let ttfbMs = 0;

  const hostname = parsedUrl.hostname;
  const path = (parsedUrl.pathname || "/") + parsedUrl.search;

  const requestPayload =
    `HEAD ${path} HTTP/1.1\r\n` +
    `Host: ${hostname}\r\n` +
    `User-Agent: UptimeEngine/2.0 (+https://yourdomain.com)\r\n` +
    `Accept: */*\r\n` +
    `Connection: keep-alive\r\n\r\n`;

  const onData = (chunk: Buffer) => {
    if (!firstByteReceived) {
      firstByteReceived = true;
      ttfbMs = Number((process.hrtime.bigint() - ttfbStart) / 1_000_000n);
    }
    responseData += chunk.toString("latin1");

    if (responseData.includes("\r\n\r\n")) {
      socket.removeListener("data", onData);
      socket.removeListener("error", onError);
      cleanup();

      // Return socket to Keep-Alive Pool for sub-50ms warm checks
      socketPool.set(poolKey, {
        socket,
        hostname,
        isHttps: parsedUrl.protocol === "https:",
        sslDaysRemaining,
        sslValid,
        expiresAt: Date.now() + 15_000, // 15s keep-alive window
      });

      const statusMatch = responseData.match(/^HTTP\/\d\.\d\s+(\d+)/);
      const statusCode = statusMatch ? parseInt(statusMatch[1], 10) : 0;

      const locationMatch = responseData.match(/^location:\s*(.+)$/im);
      const location = locationMatch ? locationMatch[1].trim() : undefined;

      if (REDIRECT_STATUS_CODES.has(statusCode) && location && redirectsLeft > 0) {
        let nextUrl: string;
        try {
          nextUrl = new URL(location, parsedUrl).toString();
        } catch {
          nextUrl = location;
        }
        executeHop(nextUrl, overallStart, timeoutMs, redirectsLeft - 1, hopsDone + 1).then(resolve);
        return;
      }

      const totalMs = Number((process.hrtime.bigint() - overallStart) / 1_000_000n);
      resolve({
        statusCode,
        dnsMs,
        tcpMs,
        tlsMs,
        ttfbMs,
        totalMs,
        sslDaysRemaining,
        sslValid,
        finalUrl: parsedUrl.toString(),
        redirectCount: hopsDone,
        errorMessage: sslError,
      });
    }
  };

  const onError = (err: any) => {
    socket.removeListener("data", onData);
    socket.removeListener("error", onError);
    cleanup();
    try {
      socket.destroy();
    } catch {}

    resolve({
      statusCode: 0,
      dnsMs,
      tcpMs,
      tlsMs,
      ttfbMs: 0,
      totalMs: Number((process.hrtime.bigint() - overallStart) / 1_000_000n),
      sslDaysRemaining,
      sslValid: false,
      finalUrl: parsedUrl.toString(),
      redirectCount: hopsDone,
      errorMessage: err.message || "Socket error during HTTP transmission",
    });
  };

  socket.on("data", onData);
  socket.on("error", onError);
  socket.write(requestPayload);
}

/**
 * Re-use an existing open socket from Keep-Alive pool for sub-50ms execution
 */
async function probeOnExistingSocket(
  socket: any,
  parsedUrl: URL,
  overallStart: bigint,
  timeoutMs: number,
  redirectsLeft: number,
  hopsDone: number,
  poolKey: string,
  sslDaysRemaining: number | null,
  sslValid: boolean
): Promise<ProbeOutcome> {
  return new Promise((resolve) => {
    let timer: any;
    let resolved = false;

    const cleanup = () => {
      if (timer) clearTimeout(timer);
    };

    timer = setTimeout(() => {
      if (resolved) return;
      resolved = true;
      try {
        socket.destroy();
      } catch {}
      const now = process.hrtime.bigint();
      resolve({
        statusCode: 0,
        dnsMs: 0,
        tcpMs: 0,
        tlsMs: 0,
        ttfbMs: 0,
        totalMs: Number((now - overallStart) / 1_000_000n),
        sslDaysRemaining,
        sslValid: false,
        finalUrl: parsedUrl.toString(),
        redirectCount: hopsDone,
        errorMessage: `Pooled socket connection timed out`,
      });
    }, 3000);

    dispatchHttpRequest(
      socket,
      parsedUrl,
      overallStart,
      timeoutMs,
      redirectsLeft,
      hopsDone,
      0, // dnsMs on pooled socket
      0, // tcpMs on pooled socket
      0, // tlsMs on pooled socket
      sslDaysRemaining,
      sslValid,
      undefined,
      poolKey,
      cleanup,
      (res) => {
        if (!resolved) {
          resolved = true;
          resolve(res);
        }
      }
    );
  });
}
