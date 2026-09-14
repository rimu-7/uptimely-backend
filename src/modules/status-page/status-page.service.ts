import { db, schema } from "../../db";
import { eq, and, gte } from "drizzle-orm";
import { formatLocalWithTimezone } from "../../utils/date";

export class StatusPageService {
  static async getStatusPageData(userId: string) {
    const userMonitors = await db
      .select({
        id: schema.monitors.id,
        name: schema.monitors.name,
        url: schema.monitors.url,
        status: schema.monitors.status,
        sslStatus: schema.monitors.sslStatus,
        sslDaysRemaining: schema.monitors.sslDaysRemaining,
        lastCheckedAt: schema.monitors.lastCheckedAt,
      })
      .from(schema.monitors)
      .where(eq(schema.monitors.userId, userId));

    const formattedMonitors = userMonitors.map((mon) => ({
      ...mon,
      lastCheckedAtLocal: mon.lastCheckedAt ? formatLocalWithTimezone(new Date(mon.lastCheckedAt)) : null,
    }));

    const stats = await db
      .select()
      .from(schema.hourlyStats)
      .where(
        and(
          gte(schema.hourlyStats.bucket, new Date(Date.now() - 7 * 24 * 60 * 60 * 1000))
        )
      )
      .orderBy(schema.hourlyStats.bucket);

    return { monitors: formattedMonitors, stats };
  }
}
