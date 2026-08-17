/**
 * Drops observations that repeat the row before them.
 *
 * The log is meant to record how a wallet's numbers moved between scans, but a
 * rescan of an unchanged wallet writes the same figures again. Those rows carry
 * no history: wallet_tokens.times_observed already counts the sightings.
 * The first and last observation of each pair are always kept.
 *
 * Usage: node scripts/prune-duplicate-observations.mjs [--apply]
 */
import postgres from "postgres";

const url = process.env.POSTGRES_URL_NON_POOLING || process.env.POSTGRES_URL;
if (!url) {
  console.error("No POSTGRES_URL_NON_POOLING / POSTGRES_URL in env.");
  process.exit(1);
}

const apply = process.argv.includes("--apply");
const sql = postgres(url, { prepare: false, max: 1 });

const doomed = sql`
  select id from (
    select id, realized_pnl_usd, rank,
           lag(realized_pnl_usd) over w prev_pnl,
           lag(rank) over w prev_rank,
           lead(id) over w next_id
    from observations
    window w as (partition by wallet_id, token_id order by observed_at, id)
  ) s
  where prev_pnl is not null
    and next_id is not null
    and realized_pnl_usd = prev_pnl
    and rank is not distinct from prev_rank
`;

try {
  const before = (await sql`select count(*)::int c from observations`)[0].c;
  const ids = (await doomed).map((r) => r.id);
  console.log(`observations: ${before}`);
  console.log(`redundant repeats: ${ids.length} (${((ids.length / before) * 100).toFixed(1)}%)`);

  if (!apply) {
    console.log("\nDry run. Re-run with --apply to delete.");
  } else if (ids.length > 0) {
    const del = await sql`delete from observations where id in ${sql(ids)}`;
    console.log(`\ndeleted ${del.count} rows, ${before - del.count} remain`);
  }
} finally {
  await sql.end();
}
