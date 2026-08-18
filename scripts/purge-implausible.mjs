// Removes stored rows whose figures no arithmetic can justify.
//
// Two distinct faults, both from a cost basis too small to divide by:
//   * wallet_positions imported from GMGN with $102B profit on a $360 buy
//     (283,265,921x) — an illiquid-pool price feed, not a trade.
//   * multiples above 500x, which in every sampled case came from a wallet that
//     received its tokens by transfer so only dust was ever recorded as bought.
//
// Usage:
//   node --env-file=.env.local scripts/purge-implausible.mjs           # report
//   node --env-file=.env.local scripts/purge-implausible.mjs --apply   # delete

import postgres from "postgres";

const APPLY = process.argv.includes("--apply");
const url = process.env.POSTGRES_URL_NON_POOLING || process.env.POSTGRES_URL;
if (!url) {
  console.error("No POSTGRES_URL_NON_POOLING / POSTGRES_URL in env.");
  process.exit(1);
}

// Must match the ceilings in scripts/enrich-wallets.mjs.
const MAX_MULTIPLE = 500;
const MAX_PNL_USD = 100_000_000;
const MIN_COST_BASIS_USD = 100;

const sql = postgres(url, { ssl: "require", prepare: false });

const positions = await sql`
  select w.address, p.wallet_id, p.token_address, p.symbol,
         round(p.multiple_x::numeric, 0) as x,
         round(p.total_pnl_usd::numeric) as pnl,
         round(p.bought_usd::numeric, 2) as bought
  from wallet_positions p
  join wallets w on w.id = p.wallet_id
  where p.multiple_x > ${MAX_MULTIPLE}
     or p.total_pnl_usd > ${MAX_PNL_USD}
     or p.bought_usd < ${MIN_COST_BASIS_USD}
  order by p.multiple_x desc nulls last`;

const tokenRows = await sql`
  select wt.wallet_id, wt.token_id, t.symbol,
         round(wt.multiple_x::numeric, 0) as x,
         round(wt.realized_pnl_usd::numeric) as pnl,
         round(wt.bought_usd::numeric, 2) as bought
  from wallet_tokens wt
  join tokens t on t.id = wt.token_id
  where wt.multiple_x > ${MAX_MULTIPLE}
  order by wt.multiple_x desc`;

console.log(`wallet_positions to drop: ${positions.length}`);
for (const r of positions.slice(0, 10)) {
  console.log(`  $${r.symbol} ${r.x}x pnl=$${r.pnl} bought=$${r.bought}`);
}
if (positions.length > 10) console.log(`  … +${positions.length - 10} more`);

console.log(`\nwallet_tokens to keep but null the multiple on: ${tokenRows.length}`);
for (const r of tokenRows) {
  console.log(`  $${r.symbol} ${r.x}x pnl=$${r.pnl} bought=$${r.bought}`);
}

if (positions.length === 0 && tokenRows.length === 0) {
  console.log("\nnothing to purge.");
  await sql.end();
  process.exit(0);
}

if (!APPLY) {
  console.log("\nDry run. Re-run with --apply to delete.");
  await sql.end();
  process.exit(0);
}

await sql.begin(async (tx) => {
  await tx`
    delete from wallet_positions
    where multiple_x > ${MAX_MULTIPLE}
       or total_pnl_usd > ${MAX_PNL_USD}
       or bought_usd < ${MIN_COST_BASIS_USD}`;

  // wallet_tokens rows are kept: the realized PNL is measured, only the ratio is
  // unreliable. Nulling the multiple hides it from the X column and the 2x gate
  // without discarding a scan someone paid for.
  await tx`
    update wallet_tokens set multiple_x = null, roi_percent = null
    where multiple_x > ${MAX_MULTIPLE}`;

  // Badges were rendered from the rows just deleted, so rebuild them from what
  // survived rather than leaving a tag citing a purged position.
  await tx`
    update wallets w
    set win_badges = coalesce((
      select array_agg(badge order by pnl desc)
      from (
        select '[' || round(p.multiple_x)::text || 'X] ' ||
               case
                 when abs(p.total_pnl_usd) >= 1000000 then '$' || round((p.total_pnl_usd/1000000)::numeric, 2)::text || 'M'
                 when abs(p.total_pnl_usd) >= 1000 then '$' || round((p.total_pnl_usd/1000)::numeric, 1)::text || 'K'
                 else '$' || round(p.total_pnl_usd::numeric, 2)::text
               end || ' $' || p.symbol as badge,
               p.total_pnl_usd as pnl
        from wallet_positions p
        where p.wallet_id = w.id
          and p.symbol is not null
          and p.multiple_x >= 2
          and p.total_pnl_usd >= 1000
      ) b
    ), '{}')
    where w.enriched_at is not null`;
});

console.log(
  `\ndeleted ${positions.length} positions, nulled ${tokenRows.length} wallet_tokens multiples, badges rebuilt.`
);
await sql.end();
