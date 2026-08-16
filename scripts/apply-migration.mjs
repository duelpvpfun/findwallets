// One-off helper: applies generated Drizzle SQL directly, since `drizzle-kit push`
// stalls against Supabase's pooler. Run with: node scripts/apply-migration.mjs
import fs from "node:fs";
import path from "node:path";
import postgres from "postgres";

const url = process.env.POSTGRES_URL_NON_POOLING || process.env.DATABASE_URL || process.env.POSTGRES_URL;
if (!url) {
  console.error("No connection string found in env.");
  process.exit(1);
}

const dir = "drizzle";
const file = fs.readdirSync(dir).filter((f) => f.endsWith(".sql")).sort().pop();
if (!file) {
  console.error("No .sql migration found in drizzle/.");
  process.exit(1);
}

const sql = postgres(url, { prepare: false });
const ddl = fs.readFileSync(path.join(dir, file), "utf8");

let applied = 0;
let skipped = 0;
for (const raw of ddl.split("--> statement-breakpoint")) {
  const stmt = raw.trim();
  if (!stmt) continue;
  try {
    await sql.unsafe(stmt);
    applied++;
  } catch (err) {
    if (String(err.message).includes("already exists")) skipped++;
    else {
      console.error("FAILED:", err.message);
      await sql.end();
      process.exit(1);
    }
  }
}

const tables = await sql`
  select table_name from information_schema.tables
  where table_schema = 'public' order by 1
`;
console.log(`applied=${applied} skipped=${skipped}`);
console.log("TABLES:", tables.map((t) => t.table_name).join(", ") || "(none)");
await sql.end();
