import "server-only";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

// The wallet database is optional: without a connection string the app runs
// exactly as before, just without persistence. Callers must handle a null db.
// POSTGRES_URL is what the Vercel/Supabase integration injects automatically.
function connectionString(): string | undefined {
  return process.env.DATABASE_URL || process.env.POSTGRES_URL;
}

let client: ReturnType<typeof postgres> | null = null;
let dbInstance: ReturnType<typeof drizzle<typeof schema>> | null = null;

export function getDb() {
  const url = connectionString();
  if (!url) return null;
  if (!dbInstance) {
    // prepare:false is required for transaction-pooled (pgBouncer) connections.
    // On serverless every warm instance holds its own pool, so `max` is
    // multiplied by concurrency: 5 each against Supabase's 60-connection cap
    // exhausts the database at 12 instances. One connection per instance,
    // released after 20s idle, keeps the ceiling in instance count instead.
    client = postgres(url, { prepare: false, max: 1, idle_timeout: 20, connect_timeout: 10 });
    dbInstance = drizzle(client, { schema });
  }
  return dbInstance;
}

export function isDbConfigured(): boolean {
  return Boolean(connectionString());
}

export { schema };
