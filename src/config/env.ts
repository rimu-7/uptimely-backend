export const config = {
  port: Number(process.env.PORT) || 3001,
  databaseUrl: process.env.DATABASE_URL || "",
  directUrl: process.env.DIRECT_URL || process.env.DATABASE_URL || "",
  upstashUrl: process.env.UPSTASH_REDIS_REST_URL || "",
  upstashToken: process.env.UPSTASH_REDIS_REST_TOKEN || "",
  jwtSecret: process.env.SUPABASE_JWT_SECRET || process.env.JWT_SECRET || "bc4aeac4-bd75-4446-8513-f28a827fa12c",
  probeConcurrency: Number(process.env.PROBE_CONCURRENCY) || 25,
  discordWebhook: process.env.DISCORD_WEBHOOK_URL,
  resendApiKey: process.env.RESEND_API_KEY,
  alertEmail: process.env.ALERT_FROM_EMAIL || "alerts@rimubhai.com",
  alertToEmail: process.env.ALERT_TO_EMAIL,
};
