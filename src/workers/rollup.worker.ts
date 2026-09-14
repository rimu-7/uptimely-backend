import { db } from "../db";
import { sql } from "drizzle-orm";

export async function runHourlyRollups() {
  const timestamp = new Date().toLocaleTimeString();
  console.log(`\n📊 [ROLLUP WORKER] ${timestamp} - Starting hourly metrics aggregation and log retention pruning...`);

  const startTime = Date.now();

  try {
    // 1. Aggregate data from previous hour into hourly_stats
    await db.execute(sql`
      INSERT INTO hourly_stats (monitor_id, bucket, uptime_pct, avg_latency, p95_latency, checks_count)
      SELECT 
        monitor_id,
        date_trunc('hour', created_at) AS bucket,
        ROUND((COUNT(*) FILTER (WHERE status_code >= 200 AND status_code < 400)::numeric / COUNT(*)::numeric) * 100, 2) AS uptime_pct,
        ROUND(AVG(total_ms)) AS avg_latency,
        PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY total_ms) AS p95_latency,
        COUNT(*) AS checks_count
      FROM check_results
      WHERE created_at >= date_trunc('hour', NOW() - INTERVAL '1 hour')
        AND created_at < date_trunc('hour', NOW())
      GROUP BY monitor_id, date_trunc('hour', created_at)
      ON CONFLICT (monitor_id, bucket) DO UPDATE 
      SET uptime_pct = EXCLUDED.uptime_pct,
          avg_latency = EXCLUDED.avg_latency,
          p95_latency = EXCLUDED.p95_latency,
          checks_count = EXCLUDED.checks_count;
    `);
    console.log(`  ✅ [Rollup Worker] Aggregated hourly metrics into hourly_stats.`);

    // 2. Prune raw logs older than 24 hours to keep the DB footprint < 50MB
    await db.execute(sql`
      DELETE FROM check_results 
      WHERE created_at < NOW() - INTERVAL '24 hours';
    `);
    console.log(`  🧹 [Rollup Worker] Pruned raw check_results older than 24 hours.`);

    const elapsed = Date.now() - startTime;
    console.log(`🏁 [ROLLUP WORKER COMPLETED] ${timestamp} - Finished in ${elapsed}ms\n`);
  } catch (err: any) {
    console.error(`❌ [Rollup Worker Error] ${timestamp} - Migration/Aggregation failed:`, err.message || err);
  }
}
