import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";
import { config } from "../config/env";

// Connection pool tuned for Bun & Supabase Transaction Pooler
const client = postgres(config.databaseUrl, {
  max: 15,
  idle_timeout: 20,
  connect_timeout: 10,
  prepare: false, // MANDATORY for Supabase PgBouncer (port 6543)
});

export const db = drizzle(client, { schema });
export { client, schema };
