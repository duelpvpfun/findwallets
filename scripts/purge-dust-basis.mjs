/**
 * Removes wallet_token rows whose multiple is an artifact of a missing cost basis.
 *
 * Tokens that arrive by airdrop or transfer have no tracked buy, so invested_usd
 * holds only the dust that was actually purchased. Dividing realized PNL by it
 * yields figures like 184838x on $16.45 spent. These are not exceptional traders
 * and they poison both the ticker and the "also won" lists.
 *
 * Usage: node scripts/purge-dust-basis.mjs [--apply]
 */
import postgres from "postgres";

const url = process.env.POSTGRES_URL_NON_POOLING || process.env.POSTGRES_URL;
if (!url) {
  console.error("No POSTGRES_URL_NON_POOLING / POSTGRES_URL in env.");
  process.exit(1);
}

const MIN_INVESTED = 1000;
const MAX_MULTIPLE = 100;
const apply = process.argv.includes("--apply");
const sql = postgres(url, { prepare: false, max: 1 });

try {
  const doomed = await sql`
    select wt.wallet_id, wt.token_id, w.address, t.symbol,
           wt.realized_pnl_usd, wt.invested_usd,
           round(wt.multiple_x::numeric, 0) as x
    from wallet_tokens wt
    join wallets w on w.id = wt.wallet_id
    join tokens t on t.id = wt.token_id
    where wt.invested_usd < ${MIN_INVESTED} and wt.multiple_x > ${MAX_MULTIPLE}
    order by wt.multiple_x desc
  `;

  console.log(`rows with invested < $${MIN_INVESTED} and multiple > ${MAX_MULTIPLE}x: ${doomed.length}`);
  console.table(doomed.map((r) => ({
    symbol: r.symbol,
    pnl: Math.round(r.realized_pnl_usd),
    invested: Number(r.invested_usd).toFixed(2),
    x: r.x,
  })));

  if (!apply) {
    console.log("\nDry run. Re-run with --apply to delete.");
  } else if (doomed.length > 0) {
    // Observations reference the same pair and would otherwise keep the bad
    // numbers alive in history, so they go first.
    const obs = await sql`
      delete from observations o
      where exists (
        select 1 from wallet_tokens wt
        where wt.wallet_id = o.wallet_id and wt.token_id = o.token_id
          and wt.invested_usd < ${MIN_INVESTED} and wt.multiple_x > ${MAX_MULTIPLE}
      )
    `;
    const del = await sql`
      delete from wallet_tokens
      where invested_usd < ${MIN_INVESTED} and multiple_x > ${MAX_MULTIPLE}
    `;
    console.log(`\ndeleted ${del.count} wallet_tokens rows, ${obs.count} observations`);

    const orphans = await sql`
      delete from wallets w
      where not exists (select 1 from wallet_tokens wt where wt.wallet_id = w.id)
    `;
    console.log(`deleted ${orphans.count} wallets left with no tokens`);
  }
} finally {
  await sql.end();
}
