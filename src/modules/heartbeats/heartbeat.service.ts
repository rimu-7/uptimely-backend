import { db, schema } from "../../db";
import { eq, and, desc } from "drizzle-orm";
import { CronService } from "../../services/cron.service";
import { formatLocalWithTimezone } from "../../utils/date";

export interface CreateHeartbeatDTO {
  name: string;
  slug: string;
  expectedInterval: number;
  gracePeriod?: number;
}

export class HeartbeatService {
  static async handlePing(slug: string) {
    const heartbeat = await CronService.getHeartbeat(slug);
    if (!heartbeat) return null;

    const nextDeadlineInSeconds = await CronService.processPing(heartbeat);

    return {
      status: "acknowledged",
      slug: heartbeat.slug,
      next_deadline_in_seconds: nextDeadlineInSeconds,
      last_ping_at: new Date().toISOString(),
      last_ping_at_local: formatLocalWithTimezone(new Date()),
    };
  }

  static async listUserHeartbeats(userId: string) {
    const heartbeats = await db
      .select()
      .from(schema.heartbeats)
      .where(eq(schema.heartbeats.userId, userId))
      .orderBy(desc(schema.heartbeats.createdAt));

    return heartbeats.map((hb) => ({
      ...hb,
      lastPingAtLocal: hb.lastPingAt ? formatLocalWithTimezone(new Date(hb.lastPingAt)) : null,
    }));
  }

  static async createHeartbeat(userId: string, dto: CreateHeartbeatDTO) {
    // Dev Resource Limit Enforcement: 1 Heartbeat per user account
    const [existing] = await db
      .select({ id: schema.heartbeats.id, name: schema.heartbeats.name, slug: schema.heartbeats.slug })
      .from(schema.heartbeats)
      .where(eq(schema.heartbeats.userId, userId))
      .limit(1);

    if (existing) {
      return {
        success: false as const,
        status: 400,
        error: "Heartbeat limit reached",
        message: `Dev Resource Limit: Each user account is allowed only 1 heartbeat monitor. You currently have an active heartbeat ("${existing.name}" - slug: ${existing.slug}). Please delete your existing heartbeat before creating a new one.`,
        existingHeartbeat: existing,
        suggestion: `Delete your existing heartbeat using DELETE /api/v1/heartbeats/${existing.id} first.`,
      };
    }

    console.log(`➕ [Heartbeat Service] Creating heartbeat "${dto.name}" (slug: ${dto.slug}) for User: ${userId}`);
    const [newHeartbeat] = await db
      .insert(schema.heartbeats)
      .values({
        userId,
        name: dto.name,
        slug: dto.slug,
        expectedInterval: dto.expectedInterval,
        gracePeriod: dto.gracePeriod || 60,
      })
      .returning();

    await CronService.invalidateCache(dto.slug, newHeartbeat.id);

    return {
      success: true as const,
      data: newHeartbeat,
    };
  }

  static async deleteHeartbeat(userId: string, id: string) {
    const [deleted] = await db
      .delete(schema.heartbeats)
      .where(and(eq(schema.heartbeats.id, id), eq(schema.heartbeats.userId, userId)))
      .returning();

    if (!deleted) return null;

    await CronService.invalidateCache(deleted.slug, deleted.id);
    return deleted;
  }
}
