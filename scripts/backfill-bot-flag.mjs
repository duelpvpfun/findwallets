/**
 * One-time correction: upstream identity tags mark almost nothing as a bot in
 * our data (only tag-based detection existed before), yet 232 of ~1000
 * wallets we've recorded lifetime trade counts for sit at 10k-50M trades on
 * one token — no human trades that often. record.ts now also flags these
 * going forward; this applies the same rule to what's already stored so the
 * ticker/showcase (which excludes is_bot) stops surfacing them.
 *
 * Usage: node scripts/backfill-bot-flag.mjs [--apply]
 */
import postgres from "postgres";

const url = process.env.POSTGRES_URL_NON_POOLING || process.env.POSTGRES_URL;
if (!url) {
  console.error("No POSTGRES_URL_NON_POOLING / POSTGRES_URL in env.");
  process.exit(1);
}

const THRESHOLD = 5000;
const apply = process.argv.includes("--apply");
const sql = postgres(url, { prepare: false, max: 1 });

try {
  const [{ c }] = await sql`
    select count(*)::int c from wallets where lifetime_trades >= ${THRESHOLD} and is_bot = false
  `;
  console.log(`wallets with >= ${THRESHOLD} lifetime trades not yet flagged as bots: ${c}`);

  if (!apply) {
    console.log("Dry run. Re-run with --apply to update.");
  } else {
    const updated = await sql`
      update wallets set is_bot = true where lifetime_trades >= ${THRESHOLD} and is_bot = false
      returning id
    `;
    console.log(`flagged ${updated.length} wallets as bots`);
  }
} finally {
  await sql.end();
}
