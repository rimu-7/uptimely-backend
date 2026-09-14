import { redis } from "../config/redis";
import { db, schema } from "../db";
import { eq, or } from "drizzle-orm";
import { dispatchAlert } from "./alert.service";

const CRON_DEADLINE_KEY = "crons:deadlines";
const CACHE_PREFIX = "heartbeat:slug:";

export interface CachedHeartbeat {
  id: string;
  userId: string;
  name: string;
  slug: string;
  expectedInterval: number;
  gracePeriod: number;
  status: "UP" | "LATE" | "DOWN" | "PENDING";
}

import { formatLocalTime } from "../utils/date";

export class CronService {
  /**
   * High-performance cached lookup for heartbeats by slug or UUID id.
   */
  static async getHeartbeat(identifier: string): Promise<CachedHeartbeat | null> {
    const cacheKey = `${CACHE_PREFIX}${identifier}`;

    try {
      const cached = await redis.get<CachedHeartbeat | "NOT_FOUND">(cacheKey);
      if (cached === "NOT_FOUND") {
        console.log(`ℹ️ [Heartbeat Cache] Negative lookup cached for slug/ID: "${identifier}"`);
        return null;
      }
      if (cached && typeof cached === "object" && cached.id) {
        console.log(`⚡ [Heartbeat Cache Hit] Found cached heartbeat "${cached.name}" (${cached.slug})`);
        return cached;
      }
    } catch (err) {
      console.warn("⚠️ [Redis Cache Warning]", err);
    }

    console.log(`🔍 [Heartbeat DB Lookup] Querying PostgreSQL for slug/ID: "${identifier}"`);
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(identifier);

    const [heartbeat] = await db
      .select()
      .from(schema.heartbeats)
      .where(
        isUuid
          ? or(eq(schema.heartbeats.slug, identifier), eq(schema.heartbeats.id, identifier))
          : eq(schema.heartbeats.slug, identifier)
      )
      .limit(1);

    if (!heartbeat) {
      console.warn(`❌ [Heartbeat Not Found] No heartbeat matches identifier: "${identifier}"`);
      await redis.set(cacheKey, "NOT_FOUND", { ex: 30 }).catch(() => {});
      return null;
    }

    const item: CachedHeartbeat = {
      id: heartbeat.id,
      userId: heartbeat.userId,
      name: heartbeat.name,
      slug: heartbeat.slug,
      expectedInterval: heartbeat.expectedInterval,
      gracePeriod: heartbeat.gracePeriod,
      status: heartbeat.status,
    };

    await redis.set(cacheKey, item, { ex: 3600 }).catch(() => {});
    return item;
  }

  static async invalidateCache(slug: string, id?: string) {
    const keys = [`${CACHE_PREFIX}${slug}`];
    if (id) keys.push(`${CACHE_PREFIX}${id}`);
    await redis.del(...keys).catch(() => {});
    console.log(`🗑️ [Heartbeat Cache Invalidated] Cleared cache for slug: "${slug}"`);
  }

  static async processPing(heartbeat: CachedHeartbeat): Promise<number> {
    const deadlineInSeconds = heartbeat.expectedInterval + heartbeat.gracePeriod;
    const deadlineMs = Date.now() + deadlineInSeconds * 1000;
    const timestamp = formatLocalTime();

    console.log(`📥 [Heartbeat Ping Received] ${timestamp} - "${heartbeat.name}" (${heartbeat.slug}) | Next deadline in ${deadlineInSeconds}s`);

    // 1. Update Redis Sorted Set deadline
    await redis.zadd(CRON_DEADLINE_KEY, { score: deadlineMs, member: heartbeat.id });

    // 2. Alert on recovery if previous state was DOWN
    if (heartbeat.status === "DOWN") {
      console.log(`🟢 [Heartbeat Recovered] "${heartbeat.name}" was DOWN, now marked as UP!`);
      await dispatchAlert(
        heartbeat.id,
        heartbeat.name,
        `Cron Job (${heartbeat.slug})`,
        "UP",
        undefined,
        heartbeat.userId
      );
    }

    // 3. Update database state and refresh cache
    await db
      .update(schema.heartbeats)
      .set({ status: "UP", lastPingAt: new Date() })
      .where(eq(schema.heartbeats.id, heartbeat.id));

    heartbeat.status = "UP";
    await redis.set(`${CACHE_PREFIX}${heartbeat.slug}`, heartbeat, { ex: 3600 }).catch(() => {});

    return deadlineInSeconds;
  }

  static async sweepOverdue(): Promise<string[]> {
    const now = Date.now();
    const overdue = await redis.zrange(CRON_DEADLINE_KEY, 0, now, { byScore: true });
    if (overdue.length > 0) {
      await redis.zrem(CRON_DEADLINE_KEY, ...overdue);
      console.log(`⏰ [Heartbeat Sweeper] Found ${overdue.length} overdue heartbeat(s) in Redis ZSET.`);
    }
    return overdue as string[];
  }
}
