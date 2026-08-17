/**
 * Purges wallet_tokens rows whose recorded avg buy/sell market cap is
 * physically impossible for these memecoins (e.g. TRUMP's stored median sell
 * mcap was $23B against a real all-time-high nowhere near that, with some
 * rows as high as $66.79B and Bonk rows as high as $104T). This came from a
 * bad estimatedSupply at scan time, not real trading activity, and it
 * poisons both the "wallets we're tracking" ticker and the also-won lists.
 *
 * TRUMP specifically is dropped entirely (token + all its wallet_tokens rows)
 * because the corruption there isn't a few outliers — the median row is
 * already above any plausible real market cap. Other tokens only have a
 * handful of individual bad rows removed, keeping the rest of their data.
 *
 * Usage: node scripts/purge-bad-mcap.mjs [--apply]
 */
import postgres from "postgres";

const url = process.env.POSTGRES_URL_NON_POOLING || process.env.POSTGRES_URL;
if (!url) {
  console.error("No POSTGRES_URL_NON_POOLING / POSTGRES_URL in env.");
  process.exit(1);
}

const CAP = 50_000_000_000; // $50B — above any real memecoin market cap.
const apply = process.argv.includes("--apply");
const sql = postgres(url, { prepare: false, max: 1 });

try {
  const trumpTokens = await sql`select id, symbol, name from tokens where upper(symbol) = 'TRUMP'`;
  for (const t of trumpTokens) {
    const [{ c }] = await sql`select count(*)::int c from wallet_tokens where token_id = ${t.id}`;
    console.log(`TRUMP (token id ${t.id}, "${t.name}"): dropping token entirely — ${c} wallet_tokens rows`);
  }

  const outliers = await sql`
    select wt.token_id, t.symbol, count(*)::int c
    from wallet_tokens wt
    join tokens t on t.id = wt.token_id
    where (wt.avg_sell_mcap_usd > ${CAP} or wt.avg_buy_mcap_usd > ${CAP})
      and upper(t.symbol) <> 'TRUMP'
    group by wt.token_id, t.symbol
  `;
  console.log(`\nOther tokens with individual rows over $${CAP.toLocaleString()} mcap:`);
  console.table(outliers.map((r) => ({ symbol: r.symbol, badRows: r.c })));

  if (!apply) {
    console.log("\nDry run. Re-run with --apply to delete.");
  } else {
    for (const t of trumpTokens) {
      const delWt = await sql`delete from wallet_tokens where token_id = ${t.id}`;
      console.log(`deleted ${delWt.count} wallet_tokens rows for TRUMP`);
    }
    const delTok = await sql`delete from tokens where upper(symbol) = 'TRUMP'`;
    console.log(`deleted ${delTok.count} TRUMP token row(s)`);

    const delOutliers = await sql`
      delete from wallet_tokens
      where avg_sell_mcap_usd > ${CAP} or avg_buy_mcap_usd > ${CAP}
    `;
    console.log(`deleted ${delOutliers.count} outlier wallet_tokens rows on other tokens`);

    const orphanWallets = await sql`
      delete from wallets w
      where not exists (select 1 from wallet_tokens wt where wt.wallet_id = w.id)
    `;
    console.log(`deleted ${orphanWallets.count} wallets left with no tokens`);
  }
} finally {
  await sql.end();
}
