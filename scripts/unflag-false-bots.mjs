/**
 * Corrective backfill: clears `is_bot` on wallets that only ever earned the flag
 * from a trade count.
 *
 * `record.ts` used to treat 5,000+ lifetime trades as a bot. Measured against
 * this database that was wrong, and expensively so: of 710 flagged wallets, 502
 * had no upstream bot tag at all, the threshold sat between p75 and p90 of the
 * trade distribution, and the three most-seen wallets in the whole database (22,
 * 21 and 21 tokens) were all caught by it. A memecoin trader with a high trade
 * count is a memecoin trader. The rule is gone from `record.ts`; this undoes what
 * it already wrote, including what `backfill-bot-flag.mjs` applied in bulk.
 *
 * `is_bot` is STICKY in the upsert (`is_bot or excluded.is_bot`), so removing the
 * rule unflags nothing by itself. This is the other half of that change, and it
 * must run AFTER the code fix is deployed: otherwise the next scan that touches
 * one of these wallets re-flags it. Re-running is harmless, so if in doubt, run
 * it again after the deploy.
 *
 * Wallets carrying a real upstream tag (bot, sniper-bot, arbitrage,
 * arbitrage-bot) keep the flag. Those are the provider's own labels, not ours.
 *
 * Usage: node --env-file=.env.local scripts/unflag-false-bots.mjs [--apply]
 */
import postgres from "postgres";

const url = process.env.POSTGRES_URL_NON_POOLING || process.env.POSTGRES_URL;
if (!url) {
  console.error("No POSTGRES_URL_NON_POOLING / POSTGRES_URL in env.");
  process.exit(1);
}

// Must match BOT_TAGS in src/lib/db/record.ts.
const BOT_TAGS = ["arbitrage-bot", "sniper-bot", "bot", "arbitrage"];

const apply = process.argv.includes("--apply");
const sql = postgres(url, { prepare: false, max: 1 });

// One statement at a time, never a fan-out: postgres.js pipelines concurrent
// queries and a fan-out wider than the pool hangs against Supabase's pooler.
try {
  const [before] = await sql`
    select
      count(*) filter (where is_bot)::int as flagged,
      count(*) filter (where is_bot and exists (
        select 1 from unnest(tags) t where lower(t) = any(${BOT_TAGS})))::int as tagged,
      count(*) filter (where is_bot and not exists (
        select 1 from unnest(tags) t where lower(t) = any(${BOT_TAGS})))::int as untagged
    from wallets`;

  console.log(`flagged is_bot:        ${before.flagged}`);
  console.log(`  with upstream tag:   ${before.tagged}  (keep)`);
  console.log(`  no tag, trades only: ${before.untagged}  (clear)`);

  // Reported, not changed. A tagged wallet that is somehow unflagged is the
  // opposite error and worth seeing, but clearing false positives is the job here.
  const [inverse] = await sql`
    select count(*)::int as n from wallets
    where not is_bot and exists (
      select 1 from unnest(tags) t where lower(t) = any(${BOT_TAGS}))`;
  if (inverse.n > 0) {
    console.log(`\nnote: ${inverse.n} wallet(s) carry a bot tag but are NOT flagged.`);
  }

  const sample = await sql`
    select address, times_seen, lifetime_trades from wallets
    where is_bot and not exists (
      select 1 from unnest(tags) t where lower(t) = any(${BOT_TAGS}))
    order by times_seen desc limit 5`;
  if (sample.length > 0) {
    console.log("\nmost-seen wallets being unflagged:");
    for (const w of sample) {
      console.log(
        `  ${w.address.slice(0, 8)}…  seen on ${w.times_seen} tokens, ${Number(
          w.lifetime_trades ?? 0
        ).toLocaleString("en-US")} lifetime trades`
      );
    }
  }

  if (!apply) {
    console.log("\nDry run. Re-run with --apply to clear the flag.");
  } else {
    const updated = await sql`
      update wallets set is_bot = false
      where is_bot and not exists (
        select 1 from unnest(tags) t where lower(t) = any(${BOT_TAGS}))
      returning id`;
    const [after] = await sql`select count(*) filter (where is_bot)::int as flagged from wallets`;
    console.log(`\ncleared ${updated.length} wallet(s). still flagged: ${after.flagged}`);
  }
} finally {
  await sql.end();
}
