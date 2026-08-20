// Retention pass. Nothing in the app deletes rows, so the append-only tables
// grow forever; run this periodically. Pass --dry to only count.
import postgres from "postgres";

const dry = process.argv.includes("--dry");
const sql = postgres(process.env.POSTGRES_URL_NON_POOLING || process.env.POSTGRES_URL, {
  prepare: false,
  max: 1,
});

const jobs = [
  ["site_visits older than 90d", sql`select count(*)::int c from site_visits where created_at < now() - interval '90 days'`, sql`delete from site_visits where created_at < now() - interval '90 days'`],
  ["webhook_log older than 30d", sql`select count(*)::int c from webhook_log where created_at < now() - interval '30 days'`, sql`delete from webhook_log where created_at < now() - interval '30 days'`],
  ["wallet_detail_cache older than 1d", sql`select count(*)::int c from wallet_detail_cache where fetched_at < now() - interval '1 day'`, sql`delete from wallet_detail_cache where fetched_at < now() - interval '1 day'`],
  ["payment_intents expired+pending 7d", sql`select count(*)::int c from payment_intents where status='pending' and expires_at < now() - interval '7 days'`, sql`delete from payment_intents where status='pending' and expires_at < now() - interval '7 days'`],
];

for (const [label, countQ, delQ] of jobs) {
  const [{ c }] = await countQ;
  if (dry || c === 0) {
    console.log(`${dry ? "would delete" : "skip"} ${String(c).padStart(7)}  ${label}`);
    continue;
  }
  await delQ;
  console.log(`deleted     ${String(c).padStart(7)}  ${label}`);
}

if (!dry) {
  for (const t of ["site_visits", "webhook_log", "wallet_detail_cache", "payment_intents", "wallets", "wallet_tokens"]) {
    await sql.unsafe(`vacuum analyze ${t}`);
  }
  console.log("vacuum analyze done");
}

await sql.end();
