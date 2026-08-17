/**
 * Recomputes roi_percent / multiple_x for rows cached before the PNL math fix.
 *
 * The old values came from avg_sell_price / avg_buy_price, a lifetime
 * volume-weighted price ratio that ignores tokens bought but never sold. That
 * made wallets show a multiple below 1.00x while realized PNL was strongly
 * positive. The new basis is realized PNL over capital deployed, which is
 * exactly `realized_pnl_usd / invested_usd` -- both already stored, so no
 * upstream re-scan is needed.
 *
 * Usage: node scripts/backfill-pnl-math.mjs [--apply]
 * Without --apply it only reports what would change.
 */
import postgres from "postgres";

const url =
  process.env.POSTGRES_URL_NON_POOLING ||
  process.env.POSTGRES_URL ||
  process.env.DATABASE_URL;

if (!url) {
  console.error("No POSTGRES_URL_NON_POOLING / POSTGRES_URL in env.");
  process.exit(1);
}

const apply = process.argv.includes("--apply");
const sql = postgres(url, { prepare: false, max: 1 });

try {
  const [{ count: stale }] = await sql`
    select count(*)::int as count
    from wallet_tokens
    where invested_usd > 0
      and abs(multiple_x - (1 + realized_pnl_usd / invested_usd)) > 0.005
  `;

  const [{ count: contradictory }] = await sql`
    select count(*)::int as count
    from wallet_tokens
    where invested_usd > 0
      and (realized_pnl_usd > 0) <> (multiple_x > 1)
  `;

  console.log(`rows needing recompute: ${stale}`);
  console.log(`  of which sign-contradictory (the visible bug): ${contradictory}`);

  if (!apply) {
    const sample = await sql`
      select wallet_id, realized_pnl_usd, invested_usd, roi_percent, multiple_x,
             round((realized_pnl_usd / invested_usd * 100)::numeric, 2) as new_roi,
             round((1 + realized_pnl_usd / invested_usd)::numeric, 3) as new_x
      from wallet_tokens
      where invested_usd > 0 and (realized_pnl_usd > 0) <> (multiple_x > 1)
      order by realized_pnl_usd desc
      limit 5
    `;
    console.table(sample);
    console.log("\nDry run. Re-run with --apply to write.");
  } else {
    const res = await sql`
      update wallet_tokens
      set roi_percent = realized_pnl_usd / invested_usd * 100,
          multiple_x  = 1 + realized_pnl_usd / invested_usd
      where invested_usd > 0
        and abs(multiple_x - (1 + realized_pnl_usd / invested_usd)) > 0.005
    `;
    console.log(`updated ${res.count} rows`);
  }
} finally {
  await sql.end();
}
