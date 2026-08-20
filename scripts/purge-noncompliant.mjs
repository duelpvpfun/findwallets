// Enforces the alpha-wallet rule across the whole database, retroactively.
//
// `wallet_tokens` and `wallet_positions` are a curated list of wallets worth
// tracking: a row only belongs there if the trade cleared **2x AND $1,000**.
// `meetsQualityBar` gates that on write, but rows predating the gate — and rows
// whose multiple was later revised downward or nulled by a backfill (see
// purge-dust-basis.mjs, backfill-pnl-math.mjs) — were never re-checked. This
// sweeps them.
//
// A null multiple counts as non-compliant. It means the cost basis was dust from
// an untracked transfer, so there is no measurable return even when the PNL is
// large — the rule needs both halves, and a return we can't measure isn't 2x.
//
// Wallets left with no compliant trade are deleted too, UNLESS they still carry
// GMGN-discovered win badges: those are proven wins on tokens nobody paid to
// scan here, so the wallet is still alpha, just not via a scan of ours.
//
// Usage:
//   node --env-file=.env.local scripts/purge-noncompliant.mjs           # report only
//   node --env-file=.env.local scripts/purge-noncompliant.mjs --apply   # delete

import postgres from "postgres";

const APPLY = process.argv.includes("--apply");
const url = process.env.POSTGRES_URL_NON_POOLING || process.env.POSTGRES_URL;
if (!url) {
  console.error("No POSTGRES_URL_NON_POOLING / POSTGRES_URL in env.");
  process.exit(1);
}

// Must match MIN_WALLET_MULTIPLE_X / MIN_WALLET_PNL_USD in src/lib/quality.ts.
const MIN_MULTIPLE_X = 2;
const MIN_PNL_USD = 1000;

const sql = postgres(url, { ssl: "require", prepare: false });

const n = (v) => Number(v ?? 0);
const usd = (v) => `$${Math.round(n(v)).toLocaleString("en-US")}`;

console.log(
  `Rule: multiple_x >= ${MIN_MULTIPLE_X} AND realized/total PNL >= ${usd(MIN_PNL_USD)}` +
    `${APPLY ? "" : "   [REPORT ONLY — pass --apply to delete]"}\n`
);

/* -- wallet_tokens --------------------------------------------------------- */

const tokenBreakdown = await sql`
  select case
           when multiple_x is null then 'null multiple (dust basis)'
           when multiple_x < ${MIN_MULTIPLE_X} and realized_pnl_usd < ${MIN_PNL_USD} then 'under both'
           when multiple_x < ${MIN_MULTIPLE_X} then 'under 2x'
           else 'under $1k'
         end as why,
         count(*)::int as rows,
         min(realized_pnl_usd) as min_pnl,
         max(realized_pnl_usd) as max_pnl
  from wallet_tokens
  where multiple_x is null or multiple_x < ${MIN_MULTIPLE_X} or realized_pnl_usd < ${MIN_PNL_USD}
  group by 1 order by rows desc`;

const tokenTotal = await sql`select count(*)::int as n from wallet_tokens`;
const tokenBad = tokenBreakdown.reduce((s, r) => s + r.rows, 0);

console.log(`wallet_tokens — ${tokenBad} of ${tokenTotal[0].n} rows non-compliant`);
for (const r of tokenBreakdown) {
  console.log(
    `  ${String(r.rows).padStart(4)}  ${r.why.padEnd(26)} PNL ${usd(r.min_pnl)} .. ${usd(r.max_pnl)}`
  );
}

// The biggest ones by PNL, so a large profit is never deleted unseen.
const notable = await sql`
  select w.address, t.symbol, wt.realized_pnl_usd, wt.multiple_x
  from wallet_tokens wt
  join wallets w on w.id = wt.wallet_id
  join tokens t on t.id = wt.token_id
  where wt.multiple_x is null or wt.multiple_x < ${MIN_MULTIPLE_X}
     or wt.realized_pnl_usd < ${MIN_PNL_USD}
  order by wt.realized_pnl_usd desc limit 5`;
if (notable.length > 0) {
  console.log("  largest by PNL:");
  for (const r of notable) {
    const x = r.multiple_x === null ? "no multiple" : `${n(r.multiple_x).toFixed(2)}x`;
    console.log(`     ${usd(r.realized_pnl_usd).padStart(10)} @ ${x.padEnd(12)} $${r.symbol ?? "?"}`);
  }
}

/* -- wallet_positions ------------------------------------------------------ */

const posBad = await sql`
  select count(*)::int as rows,
         count(*) filter (where multiple_x is null)::int as null_multiple,
         count(*) filter (where multiple_x < ${MIN_MULTIPLE_X})::int as under_x,
         count(*) filter (where total_pnl_usd < ${MIN_PNL_USD})::int as under_pnl
  from wallet_positions
  where multiple_x is null or multiple_x < ${MIN_MULTIPLE_X} or total_pnl_usd < ${MIN_PNL_USD}`;
const posTotal = await sql`select count(*)::int as n from wallet_positions`;
console.log(`\nwallet_positions — ${posBad[0].rows} of ${posTotal[0].n} rows non-compliant`);
if (posBad[0].rows > 0) {
  console.log(
    `  null multiple ${posBad[0].null_multiple} · under 2x ${posBad[0].under_x} · under $1k ${posBad[0].under_pnl}`
  );
}

/* -- wallets that would be left with nothing ------------------------------- */

// Counted BEFORE deleting, by asking which wallets have no compliant row in
// either table. `win_badges` is the reprieve: a wallet with proven wins on
// tokens nobody scanned here is still alpha.
const orphans = await sql`
  with compliant as (
    select wallet_id from wallet_tokens
    where multiple_x >= ${MIN_MULTIPLE_X} and realized_pnl_usd >= ${MIN_PNL_USD}
    union
    select wallet_id from wallet_positions
    where multiple_x >= ${MIN_MULTIPLE_X} and total_pnl_usd >= ${MIN_PNL_USD}
  )
  select count(*)::int as total,
         count(*) filter (where array_length(w.win_badges, 1) > 0)::int as with_badges
  from wallets w
  where w.id not in (select wallet_id from compliant)`;

const deletable = orphans[0].total - orphans[0].with_badges;
const walletTotal = await sql`select count(*)::int as n from wallets`;
console.log(`\nwallets — ${walletTotal[0].n} total`);
console.log(`  ${orphans[0].total} would have no compliant trade left`);
console.log(`  ${orphans[0].with_badges} of those keep GMGN win badges -> KEPT`);
console.log(`  ${deletable} to delete`);

/* -- apply ----------------------------------------------------------------- */

if (!APPLY) {
  console.log("\nNothing changed. Re-run with --apply to delete.");
  await sql.end();
  process.exit(0);
}

console.log("\napplying…");

// One transaction: a half-applied purge leaves wallets with no trades and
// trades pointing at deleted wallets.
const result = await sql.begin(async (tx) => {
  const tok = await tx`
    delete from wallet_tokens
    where multiple_x is null or multiple_x < ${MIN_MULTIPLE_X} or realized_pnl_usd < ${MIN_PNL_USD}
    returning wallet_id`;

  const pos = await tx`
    delete from wallet_positions
    where multiple_x is null or multiple_x < ${MIN_MULTIPLE_X} or total_pnl_usd < ${MIN_PNL_USD}
    returning wallet_id`;

  // Re-derived after the deletes rather than reusing the count above, so the
  // statement that decides what to delete is the one holding the lock.
  const wal = await tx`
    delete from wallets w
    where array_length(w.win_badges, 1) is null
      and not exists (select 1 from wallet_tokens wt where wt.wallet_id = w.id)
      and not exists (select 1 from wallet_positions wp where wp.wallet_id = w.id)
    returning w.id`;

  return { tokens: tok.length, positions: pos.length, wallets: wal.length };
});

console.log(`  wallet_tokens rows deleted:    ${result.tokens}`);
console.log(`  wallet_positions rows deleted: ${result.positions}`);
console.log(`  wallets deleted:               ${result.wallets}`);

/* -- prove the invariant now holds ---------------------------------------- */

const [check] = await sql`
  select
    (select count(*)::int from wallet_tokens
     where multiple_x is null or multiple_x < ${MIN_MULTIPLE_X}
        or realized_pnl_usd < ${MIN_PNL_USD}) as bad_tokens,
    (select count(*)::int from wallet_positions
     where multiple_x is null or multiple_x < ${MIN_MULTIPLE_X}
        or total_pnl_usd < ${MIN_PNL_USD}) as bad_positions,
    (select count(*)::int from wallet_tokens) as tokens,
    (select count(*)::int from wallet_positions) as positions,
    (select count(*)::int from wallets) as wallets`;

console.log(
  `\nafter: wallet_tokens ${check.tokens}, wallet_positions ${check.positions}, wallets ${check.wallets}`
);
const clean = check.bad_tokens === 0 && check.bad_positions === 0;
console.log(
  clean
    ? "invariant holds: every stored row is >= 2x and >= $1,000."
    : `STILL NON-COMPLIANT: ${check.bad_tokens} token rows, ${check.bad_positions} position rows.`
);

await sql.end();
process.exit(clean ? 0 : 1);
