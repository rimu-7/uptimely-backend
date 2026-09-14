import { db, schema } from "../../db";
import { eq, and, desc } from "drizzle-orm";
import { formatLocalDateTime, formatLocalWithTimezone } from "../../utils/date";

export interface CreateMonitorDTO {
  name: string;
  url: string;
  method?: string;
  intervalSeconds?: number;
  expectedStatus?: number;
}

export interface UpdateMonitorDTO {
  name?: string;
  url?: string;
  method?: string;
  intervalSeconds?: number;
  timeoutMs?: number;
  expectedStatus?: number;
  isActive?: boolean;
}

export class MonitorService {
  static async listUserMonitors(userId: string) {
    const monitors = await db
      .select()
      .from(schema.monitors)
      .where(eq(schema.monitors.userId, userId))
      .orderBy(desc(schema.monitors.createdAt));

    return monitors.map((mon) => ({
      ...mon,
      lastCheckedAtLocal: mon.lastCheckedAt ? formatLocalWithTimezone(new Date(mon.lastCheckedAt)) : null,
    }));
  }

  static async getMonitorChecks(userId: string, monitorId: string) {
    const [mon] = await db
      .select()
      .from(schema.monitors)
      .where(and(eq(schema.monitors.id, monitorId), eq(schema.monitors.userId, userId)))
      .limit(1);

    if (!mon) return null;

    const rows = await db
      .select({
        id: schema.checkResults.id,
        statusCode: schema.checkResults.statusCode,
        totalMs: schema.checkResults.totalMs,
        dnsMs: schema.checkResults.dnsMs,
        tcpMs: schema.checkResults.tcpMs,
        tlsMs: schema.checkResults.tlsMs,
        ttfbMs: schema.checkResults.ttfbMs,
        errorMessage: schema.checkResults.errorMessage,
        createdAt: schema.checkResults.createdAt,
      })
      .from(schema.checkResults)
      .where(eq(schema.checkResults.monitorId, monitorId))
      .orderBy(desc(schema.checkResults.createdAt))
      .limit(20);

    return rows.map((row) => ({
      ...row,
      checkedAtLocal: formatLocalWithTimezone(new Date(row.createdAt)),
      checkedAtFormatted: formatLocalDateTime(new Date(row.createdAt)),
    }));
  }

  static async createMonitor(userId: string, dto: CreateMonitorDTO) {
    // Dev Resource Limit Enforcement: 1 Monitor URL per user account
    const [existing] = await db
      .select({ id: schema.monitors.id, name: schema.monitors.name, url: schema.monitors.url })
      .from(schema.monitors)
      .where(eq(schema.monitors.userId, userId))
      .limit(1);

    if (existing) {
      return {
        success: false as const,
        status: 400,
        error: "Monitor limit reached",
        message: `Dev Resource Limit: Each user account is allowed only 1 monitor URL. You currently have an active monitor ("${existing.name}" - ${existing.url}). Please delete your existing monitor before creating a new one.`,
        existingMonitor: existing,
        suggestion: `Delete your existing monitor using DELETE /api/v1/monitors/${existing.id} first or update it using PATCH /api/v1/monitors/${existing.id}.`,
      };
    }

    console.log(`➕ [Monitor Service] Creating synthetic monitor "${dto.name}" (${dto.url}) for User: ${userId}`);
    const [newMonitor] = await db
      .insert(schema.monitors)
      .values({
        userId,
        name: dto.name,
        url: dto.url,
        method: dto.method || "GET",
        intervalSeconds: dto.intervalSeconds || 60,
        expectedStatus: dto.expectedStatus || 200,
      })
      .returning();

    return {
      success: true as const,
      data: newMonitor,
    };
  }

  static async updateMonitor(userId: string, id: string, dto: UpdateMonitorDTO) {
    const [updated] = await db
      .update(schema.monitors)
      .set({
        ...(dto.name !== undefined && { name: dto.name }),
        ...(dto.url !== undefined && { url: dto.url }),
        ...(dto.method !== undefined && { method: dto.method }),
        ...(dto.intervalSeconds !== undefined && { intervalSeconds: dto.intervalSeconds }),
        ...(dto.timeoutMs !== undefined && { timeoutMs: dto.timeoutMs }),
        ...(dto.expectedStatus !== undefined && { expectedStatus: dto.expectedStatus }),
        ...(dto.isActive !== undefined && { isActive: dto.isActive }),
        updatedAt: new Date(),
      })
      .where(and(eq(schema.monitors.id, id), eq(schema.monitors.userId, userId)))
      .returning();

    if (!updated) return null;

    console.log(`✏️ [Monitor Service] Updated monitor "${updated.name}" (ID: ${updated.id}) - Expected Status: ${updated.expectedStatus}`);
    return updated;
  }

  static async deleteMonitor(userId: string, id: string) {
    const [deleted] = await db
      .delete(schema.monitors)
      .where(and(eq(schema.monitors.id, id), eq(schema.monitors.userId, userId)))
      .returning();

    return deleted || null;
  }
}
