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
    client = postgres(url, { prepare: false, max: 5 });
    dbInstance = drizzle(client, { schema });
  }
  return dbInstance;
}

export function isDbConfigured(): boolean {
  return Boolean(connectionString());
}

export { schema };
