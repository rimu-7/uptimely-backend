import {
  pgTable,
  uuid,
  varchar,
  text,
  integer,
  timestamp,
  bigserial,
  numeric,
  boolean,
  pgEnum,
  index,
  unique,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";

// Enums
export const monitorStatusEnum = pgEnum("monitor_status", ["UP", "DOWN", "DEGRADED", "PENDING"]);
export const sslStatusEnum = pgEnum("ssl_status", ["VALID", "EXPIRING", "EXPIRED", "INVALID"]);
export const heartbeatStatusEnum = pgEnum("heartbeat_status", ["UP", "LATE", "DOWN", "PENDING"]);
export const alertTypeEnum = pgEnum("alert_type", ["DISCORD", "SLACK", "EMAIL"]);

// Users Table (Credentials authentication)
export const users = pgTable("users", {
  id: uuid("id").defaultRandom().primaryKey(),
  email: varchar("email", { length: 255 }).unique().notNull(),
  passwordHash: text("password_hash").notNull(),
  fullName: varchar("full_name", { length: 150 }),
  isVerified: boolean("is_verified").default(false).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

// Monitors Table (Outbound synthetic probes)
export const monitors = pgTable(
  "monitors",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id").notNull(),
    name: varchar("name", { length: 100 }).notNull(),
    url: text("url").notNull(),
    method: varchar("method", { length: 10 }).default("GET").notNull(),
    intervalSeconds: integer("interval_seconds").default(60).notNull(),
    timeoutMs: integer("timeout_ms").default(10000).notNull(),
    expectedStatus: integer("expected_status").default(200).notNull(),
    status: monitorStatusEnum("status").default("PENDING").notNull(),
    sslStatus: sslStatusEnum("ssl_status").default("VALID").notNull(),
    sslDaysRemaining: integer("ssl_days_remaining"),
    isActive: boolean("is_active").default(true).notNull(),
    lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("idx_monitors_due").on(table.lastCheckedAt, table.intervalSeconds),
  ]
);

// Heartbeats Table (Inbound crons)
export const heartbeats = pgTable("heartbeats", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id").notNull(),
  name: varchar("name", { length: 100 }).notNull(),
  slug: varchar("slug", { length: 100 }).unique().notNull(),
  expectedInterval: integer("expected_interval").notNull(), // seconds
  gracePeriod: integer("grace_period").default(300).notNull(), // seconds
  status: heartbeatStatusEnum("status").default("PENDING").notNull(),
  lastPingAt: timestamp("last_ping_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

// Check Results (24h raw logs)
export const checkResults = pgTable(
  "check_results",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    monitorId: uuid("monitor_id")
      .references(() => monitors.id, { onDelete: "cascade" })
      .notNull(),
    statusCode: integer("status_code").notNull(),
    dnsMs: integer("dns_ms").default(0).notNull(),
    tcpMs: integer("tcp_ms").default(0).notNull(),
    tlsMs: integer("tls_ms").default(0).notNull(),
    ttfbMs: integer("ttfb_ms").default(0).notNull(),
    totalMs: integer("total_ms").notNull(),
    errorMessage: text("error_message"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("idx_check_results_monitor_created").on(table.monitorId, table.createdAt),
    index("idx_check_results_created_at").using("brin", table.createdAt),
  ]
);

// Hourly Aggregations (Long-term metrics)
export const hourlyStats = pgTable(
  "hourly_stats",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    monitorId: uuid("monitor_id")
      .references(() => monitors.id, { onDelete: "cascade" })
      .notNull(),
    bucket: timestamp("bucket", { withTimezone: true }).notNull(),
    uptimePct: numeric("uptime_pct", { precision: 5, scale: 2 }).notNull(),
    avgLatency: integer("avg_latency").notNull(),
    p95Latency: integer("p95_latency").notNull(),
    checksCount: integer("checks_count").notNull(),
  },
  (table) => [
    unique("uq_hourly_stats_monitor_bucket").on(table.monitorId, table.bucket),
    index("idx_hourly_stats_monitor_bucket").on(table.monitorId, table.bucket),
  ]
);

// Alert Channels
export const alertChannels = pgTable("alert_channels", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id").notNull(),
  type: alertTypeEnum("type").notNull(),
  destination: text("destination").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

// Relations
export const usersRelations = relations(users, ({ many }) => ({
  monitors: many(monitors),
  heartbeats: many(heartbeats),
  alertChannels: many(alertChannels),
}));

export const monitorsRelations = relations(monitors, ({ one, many }) => ({
  user: one(users, {
    fields: [monitors.userId],
    references: [users.id],
  }),
  checks: many(checkResults),
  stats: many(hourlyStats),
}));

export const heartbeatsRelations = relations(heartbeats, ({ one }) => ({
  user: one(users, {
    fields: [heartbeats.userId],
    references: [users.id],
  }),
}));

export const checkResultsRelations = relations(checkResults, ({ one }) => ({
  monitor: one(monitors, {
    fields: [checkResults.monitorId],
    references: [monitors.id],
  }),
}));

export const hourlyStatsRelations = relations(hourlyStats, ({ one }) => ({
  monitor: one(monitors, {
    fields: [hourlyStats.monitorId],
    references: [monitors.id],
  }),
}));

// Inferred TypeScript types
export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Monitor = typeof monitors.$inferSelect;
export type NewMonitor = typeof monitors.$inferInsert;
export type Heartbeat = typeof heartbeats.$inferSelect;
export type CheckResult = typeof checkResults.$inferSelect;
export type HourlyStat = typeof hourlyStats.$inferSelect;
