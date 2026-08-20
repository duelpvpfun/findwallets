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
    // On serverless every warm instance holds its own pool, so `max` multiplies
    // by concurrency and a large pool can exhaust the database's connection cap.
    //
    // `max: 1` is nevertheless wrong: postgres.js pipelines queries onto a
    // connection, and when a fan-out outruns the pool, Supabase's transaction
    // pooler stops responding — the queries hang forever rather than queueing,
    // taking the whole request with them. Measured live: 4 concurrent queries on
    // max:1 never returned; the same 4 on max:2 finished in 162ms. Three is
    // enough for every fan-out this app actually issues, and small enough that
    // Supabase's pooler is not the scarce resource.
    client = postgres(url, { prepare: false, max: 3, idle_timeout: 20, connect_timeout: 10 });
    dbInstance = drizzle(client, { schema });
  }
  return dbInstance;
}

export function isDbConfigured(): boolean {
  return Boolean(connectionString());
}

export { schema };
