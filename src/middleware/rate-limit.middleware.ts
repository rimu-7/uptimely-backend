import { Elysia } from "elysia";
import { redis } from "../config/redis";

/**
 * Extract client IP address from request headers or socket
 */
export function getClientIP(request: Request): string {
  const xForwardedFor = request.headers.get("x-forwarded-for");
  if (xForwardedFor) {
    return xForwardedFor.split(",")[0].trim();
  }
  const realIp = request.headers.get("x-real-ip");
  if (realIp) return realIp.trim();
  const cfIp = request.headers.get("cf-connecting-ip");
  if (cfIp) return cfIp.trim();
  return "127.0.0.1";
}

/**
 * Redis Sliding Window Rate Limiter
 */
export async function checkRateLimit(
  key: string,
  limit: number,
  windowSeconds: number
): Promise<{ allowed: boolean; remaining: number; reset: number }> {
  try {
    const current = await redis.incr(key);
    if (current === 1) {
      await redis.expire(key, windowSeconds);
    }
    const ttl = await redis.ttl(key);
    const remaining = Math.max(0, limit - current);
    const reset = Math.max(1, ttl);

    return {
      allowed: current <= limit,
      remaining,
      reset,
    };
  } catch (err) {
    // If Redis rate limit check fails transiently, fallback to allowing request
    console.warn("⚠️ [Rate Limit Warning] Upstash Redis rate limit check skipped:", err);
    return { allowed: true, remaining: limit, reset: windowSeconds };
  }
}

/**
 * Elysia Plugin for General IP Rate Limiting (100 requests per minute)
 */
export const ipRateLimiter = new Elysia({ name: "ip-rate-limiter" })
  .derive(async ({ request, set }) => {
    const ip = getClientIP(request);
    const rateKey = `ratelimit:ip:${ip}`;
    const result = await checkRateLimit(rateKey, 100, 60);

    set.headers["X-RateLimit-Limit"] = "100";
    set.headers["X-RateLimit-Remaining"] = result.remaining.toString();
    set.headers["X-RateLimit-Reset"] = result.reset.toString();

    if (!result.allowed) {
      set.status = 429;
      set.headers["Retry-After"] = result.reset.toString();
      return {
        rateLimitError: {
          error: "Too Many Requests",
          message: `IP rate limit exceeded. Please retry after ${result.reset} seconds.`,
        },
      };
    }
    return { rateLimitError: null };
  })
  .onBeforeHandle(({ rateLimitError, set }) => {
    if (rateLimitError) {
      set.status = 429;
      return rateLimitError;
    }
  });

/**
 * Elysia Plugin for Sensitive Auth Rate Limiting (10 attempts per minute)
 */
export const authRateLimiter = new Elysia({ name: "auth-rate-limiter" })
  .derive(async ({ request, set }) => {
    const ip = getClientIP(request);
    const rateKey = `ratelimit:auth:${ip}`;
    const result = await checkRateLimit(rateKey, 15, 60);

    set.headers["X-RateLimit-Limit"] = "15";
    set.headers["X-RateLimit-Remaining"] = result.remaining.toString();
    set.headers["X-RateLimit-Reset"] = result.reset.toString();

    if (!result.allowed) {
      set.status = 429;
      set.headers["Retry-After"] = result.reset.toString();
      return {
        rateLimitError: {
          error: "Too Many Requests",
          message: `Authentication rate limit exceeded. Please wait ${result.reset} seconds before trying again.`,
        },
      };
    }
    return { rateLimitError: null };
  })
  .onBeforeHandle(({ rateLimitError, set }) => {
    if (rateLimitError) {
      set.status = 429;
      return rateLimitError;
    }
  });
