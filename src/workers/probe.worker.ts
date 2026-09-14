import pLimit from "p-limit";
import { db, schema } from "../db";
import { sql, eq, and } from "drizzle-orm";
import { probeEndpoint } from "../services/probe.service";
import { dispatchAlert } from "../services/alert.service";
import { config } from "../config/env";
import { formatLocalTime } from "../utils/date";

const limit = pLimit(config.probeConcurrency);

export async function runProbeCycle() {
  const startTime = Date.now();
  const timestamp = formatLocalTime();

  // Select active monitors that are overdue for checking
  const dueMonitors = await db
    .select()
    .from(schema.monitors)
    .where(
      sql`${schema.monitors.isActive} = true AND (
        ${schema.monitors.lastCheckedAt} IS NULL OR 
        ${schema.monitors.lastCheckedAt} < NOW() - (${schema.monitors.intervalSeconds} * INTERVAL '1 second')
      )`
    );

  if (dueMonitors.length === 0) {
    return;
  }

  console.log(`\n🔍 [PROBE CYCLE STARTED] ${timestamp} - Checking ${dueMonitors.length} due monitor(s) (Concurrency limit: ${config.probeConcurrency})...`);

  let successCount = 0;
  let failureCount = 0;

  const tasks = dueMonitors.map((mon) =>
    limit(async () => {
      const outcome = await probeEndpoint(mon.url, mon.timeoutMs);
      const isUp = outcome.statusCode === mon.expectedStatus;
      const nextStatus = isUp ? "UP" : "DOWN";

      if (isUp) {
        successCount++;
        console.log(
          `  ✅ [Probe OK] "${mon.name}" (${mon.url}) => HTTP ${outcome.statusCode} in ${outcome.totalMs}ms ` +
          `(DNS: ${outcome.dnsMs}ms, TCP: ${outcome.tcpMs}ms, TLS: ${outcome.tlsMs}ms, TTFB: ${outcome.ttfbMs}ms` +
          `${outcome.sslDaysRemaining !== null ? `, SSL: ${outcome.sslDaysRemaining}d remaining` : ""})`
        );
      } else {
        failureCount++;
        console.warn(
          `  ❌ [Probe FAIL] "${mon.name}" (${mon.url}) => Status: ${outcome.statusCode} (Expected: ${mon.expectedStatus}) ` +
          `in ${outcome.totalMs}ms${outcome.errorMessage ? ` | Error: ${outcome.errorMessage}` : ""}`
        );
      }

      // 1. Insert raw check result
      await db.insert(schema.checkResults).values({
        monitorId: mon.id,
        statusCode: outcome.statusCode,
        dnsMs: outcome.dnsMs,
        tcpMs: outcome.tcpMs,
        tlsMs: outcome.tlsMs,
        ttfbMs: outcome.ttfbMs,
        totalMs: outcome.totalMs,
        errorMessage: outcome.errorMessage ?? null,
      });

      // 2. Alert on status change with tenant userId
      if (mon.status !== "PENDING" && mon.status !== nextStatus) {
        console.log(`  🔄 [Status Change] "${mon.name}": ${mon.status} ➔ ${nextStatus}`);
        await dispatchAlert(mon.id, mon.name, mon.url, nextStatus, outcome.errorMessage, mon.userId);
      }

      // 3. Update monitor state
      let sslStatus: "VALID" | "EXPIRING" | "INVALID" = "VALID";
      if (!outcome.sslValid) {
        sslStatus = "INVALID";
      } else if (outcome.sslDaysRemaining !== null && outcome.sslDaysRemaining < 14) {
        sslStatus = "EXPIRING";
      }

      await db
        .update(schema.monitors)
        .set({
          status: nextStatus,
          sslStatus,
          sslDaysRemaining: outcome.sslDaysRemaining,
          lastCheckedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(schema.monitors.id, mon.id));
    })
  );

  await Promise.all(tasks);
  const elapsed = Date.now() - startTime;
  console.log(`🏁 [PROBE CYCLE COMPLETED] ${timestamp} - ${successCount} passed, ${failureCount} failed in ${elapsed}ms\n`);
}
