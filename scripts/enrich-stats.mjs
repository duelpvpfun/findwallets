// Reports what the enrichment worker has produced so far.
// Usage: node --env-file=.env.local scripts/enrich-stats.mjs

import postgres from "postgres";

const url = process.env.POSTGRES_URL_NON_POOLING || process.env.POSTGRES_URL;
const sql = postgres(url, { ssl: "require", prepare: false });

const [totals] = await sql`
  select
    count(*) as wallets,
    count(enriched_at) as enriched,
    count(*) filter (where cardinality(win_badges) > 0) as with_badges
  from wallets
  where chain in ('solana', 'bsc', 'base')`;

const [pos] = await sql`
  select count(*) as rows, count(distinct wallet_id) as wallets,
         count(distinct token_address) as tokens
  from wallet_positions`;

const pct = totals.wallets > 0 ? ((totals.enriched / totals.wallets) * 100).toFixed(1) : "0";
console.log(`wallets:   ${totals.wallets}`);
console.log(`enriched:  ${totals.enriched} (${pct}%)`);
console.log(`badged:    ${totals.with_badges}`);
console.log(`positions: ${pos.rows} rows across ${pos.wallets} wallets / ${pos.tokens} tokens`);

const sample = await sql`
  select address, win_badges from wallets
  where cardinality(win_badges) > 0
  order by enriched_at desc
  limit 15`;

if (sample.length > 0) {
  console.log("\nlatest badges:");
  for (const w of sample) {
    console.log(`  ${w.address.slice(0, 6)}…${w.address.slice(-4)}  ${w.win_badges.join("  ")}`);
  }
}

const best = await sql`
  select w.address, p.symbol, p.multiple_x, p.total_pnl_usd
  from wallet_positions p
  join wallets w on w.id = p.wallet_id
  where p.symbol is not null and p.multiple_x is not null
  order by p.total_pnl_usd desc
  limit 10`;

if (best.length > 0) {
  console.log("\nbiggest discovered trades:");
  for (const r of best) {
    console.log(
      `  ${r.address.slice(0, 6)}…  ${Math.round(r.multiple_x)}X  $${Math.round(r.total_pnl_usd).toLocaleString()}  $${r.symbol}`
    );
  }
}

await sql.end();
