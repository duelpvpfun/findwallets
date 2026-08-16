import "server-only";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

// The wallet database is optional: without DATABASE_URL the app runs exactly as
// before, just without persistence. Callers must handle a null db.
let client: ReturnType<typeof postgres> | null = null;
let dbInstance: ReturnType<typeof drizzle<typeof schema>> | null = null;

export function getDb() {
  if (!process.env.DATABASE_URL) return null;
  if (!dbInstance) {
    client = postgres(process.env.DATABASE_URL, { prepare: false, max: 5 });
    dbInstance = drizzle(client, { schema });
  }
  return dbInstance;
}

export function isDbConfigured(): boolean {
  return Boolean(process.env.DATABASE_URL);
}

export { schema };
