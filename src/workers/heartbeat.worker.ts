import { db, schema } from "../db";
import { eq } from "drizzle-orm";
import { CronService } from "../services/cron.service";
import { dispatchAlert } from "../services/alert.service";

import { formatLocalTime } from "../utils/date";

export async function runHeartbeatSweeper() {
  const overdueIds = await CronService.sweepOverdue();

  if (overdueIds.length === 0) return;

  const timestamp = formatLocalTime();
  console.log(`\n⏰ [HEARTBEAT SWEEPER] ${timestamp} - Sweeping ${overdueIds.length} overdue heartbeat monitor(s)...`);

  for (const id of overdueIds) {
    const [cron] = await db
      .select()
      .from(schema.heartbeats)
      .where(eq(schema.heartbeats.id, id))
      .limit(1);

    if (cron && cron.status !== "DOWN") {
      await db
        .update(schema.heartbeats)
        .set({ status: "DOWN" })
        .where(eq(schema.heartbeats.id, id));

      console.warn(`🚨 [Cron Missed Deadline] "${cron.name}" (slug: ${cron.slug}) missed its check-in interval of ${cron.expectedInterval}s! Marked as DOWN.`);

      await dispatchAlert(
        cron.id,
        cron.name,
        `Cron Job (${cron.slug})`,
        "DOWN",
        `Missed expected ping interval of ${cron.expectedInterval}s`,
        cron.userId
      );
    }
  }
}
