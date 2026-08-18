// Audits stored wallet_tokens rows against the corrected math and reports (or
// repairs) rows that disagree.
//
// `multiple_x` / `roi_percent` were originally computed as realized PNL over the
// ENTIRE buy volume, which charges a wallet for tokens it never sold: a genuine
// 2.4x round trip on 4% of a bag was stored as 1.06x. The corrected basis is the
// cost of the tokens actually sold. Token amounts aren't stored, but they are
// recoverable from bought_usd / avg_buy_price_usd, so old rows can be repaired
// in place rather than rescanned at upstream cost.
//
// Also flags rows that no arithmetic can fix, so bad input is visible rather
// than silently rewritten.
//
// Usage:
//   node --env-file=.env.local scripts/audit-pnl-math.mjs           # report only
//   node --env-file=.env.local scripts/audit-pnl-math.mjs --apply   # rewrite

import postgres from "postgres";

const APPLY = process.argv.includes("--apply");
const url = process.env.POSTGRES_URL_NON_POOLING || process.env.POSTGRES_URL;
if (!url) {
  console.error("No POSTGRES_URL_NON_POOLING / POSTGRES_URL in env.");
  process.exit(1);
}

const sql = postgres(url, { ssl: "require", prepare: false });

// Must match MIN_COST_BASIS_USD / realizedBasisUsd in src/lib/quality.ts.
const MIN_COST_BASIS_USD = 100;
const realizedBasisUsd = (soldCost, bought) =>
  soldCost >= MIN_COST_BASIS_USD ? soldCost : Math.max(soldCost, bought);
// Matches scripts/purge-implausible.mjs.
const MAX_PLAUSIBLE_MULTIPLE = 500;

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const rows = await sql`
  select wt.wallet_id, wt.token_id, t.chain, t.symbol,
         wt.realized_pnl_usd, wt.roi_percent, wt.multiple_x,
         wt.bought_usd, wt.proceeds_usd,
         wt.avg_buy_price_usd, wt.avg_sell_price_usd,
         wt.remaining_percent, wt.unrealized_pnl_usd
  from wallet_tokens wt
  join tokens t on t.id = wt.token_id`;

console.log(`auditing ${rows.length} wallet_tokens rows${APPLY ? " [APPLY]" : " [REPORT ONLY]"}\n`);

const fixes = [];
const issues = {
  staleMultiple: 0,
  negativeBasis: 0,
  missingInputs: 0,
  impossibleRemaining: 0,
  multipleRoiMismatch: 0,
  suppressed: 0,
  ok: 0,
};
const samples = [];

for (const r of rows) {
  const bought = num(r.bought_usd);
  const proceeds = num(r.proceeds_usd);
  const avgBuy = num(r.avg_buy_price_usd);
  const avgSell = num(r.avg_sell_price_usd);
  const pnl = num(r.realized_pnl_usd);
  const storedX = num(r.multiple_x);
  const storedRoi = num(r.roi_percent);

  if (r.remaining_percent !== null && (r.remaining_percent < 0 || r.remaining_percent > 100)) {
    issues.impossibleRemaining++;
  }

  if (pnl === null || !bought || bought <= 0 || !avgBuy || avgBuy <= 0) {
    issues.missingInputs++;
    continue;
  }

  // Recover the token counts the same way showcase.ts does.
  const tokensBought = bought / avgBuy;
  const tokensSold = avgSell && avgSell > 0 && proceeds ? proceeds / avgSell : 0;
  const soldCost = Math.min(tokensSold, tokensBought) * avgBuy;

  if (soldCost <= 0) {
    // Nothing sold: a realized multiple is meaningless, so 0/null is correct.
    if (storedX !== null && storedX > 1.0001) {
      issues.negativeBasis++;
      fixes.push({ ...r, newX: null, newRoi: null });
    } else {
      issues.ok++;
    }
    continue;
  }

  const basis = realizedBasisUsd(soldCost, bought);
  const correctX = 1 + pnl / basis;
  const correctRoi = (pnl / basis) * 100;

  // Suppressed by purge-implausible.mjs: the ratio was an artifact of a dust
  // basis even though the PNL is real. Recomputing would reinstate it.
  if (!storedX && !storedRoi && correctX > MAX_PLAUSIBLE_MULTIPLE) {
    issues.suppressed++;
    continue;
  }

  // 1% tolerance: floating-point drift and upstream rounding are not bugs.
  const xOff = storedX === null || Math.abs(storedX - correctX) / Math.max(1, Math.abs(correctX)) > 0.01;
  const roiOff =
    storedRoi === null || Math.abs(storedRoi - correctRoi) / Math.max(1, Math.abs(correctRoi)) > 0.01;

  // A row whose own two fields disagree is corrupt regardless of which basis
  // was used, since both derive from the same PNL.
  if (storedX !== null && storedRoi !== null) {
    const impliedFromRoi = 1 + storedRoi / 100;
    if (Math.abs(impliedFromRoi - storedX) / Math.max(1, Math.abs(storedX)) > 0.02) {
      issues.multipleRoiMismatch++;
    }
  }

  if (xOff || roiOff) {
    issues.staleMultiple++;
    fixes.push({ ...r, newX: correctX, newRoi: correctRoi });
    if (samples.length < 12) {
      const dust = basis !== soldCost ? " [dust basis, fell back to bought]" : "";
      samples.push(
        `  $${(r.symbol || "?").padEnd(12)} stored ${storedX === null ? "null" : storedX.toFixed(2) + "x"} → ${correctX.toFixed(2)}x  (pnl $${Math.round(pnl).toLocaleString()}, basis $${Math.round(basis).toLocaleString()})${dust}`
      );
    }
  } else {
    issues.ok++;
  }
}

console.log("findings:");
console.log(`  correct already:            ${issues.ok}`);
console.log(`  stale multiple/roi:         ${issues.staleMultiple}`);
console.log(`  suppressed (dust basis):    ${issues.suppressed}`);
console.log(`  multiple claimed, none sold:${issues.negativeBasis}`);
console.log(`  missing inputs (skipped):   ${issues.missingInputs}`);
console.log(`  multiple vs roi disagree:   ${issues.multipleRoiMismatch}`);
console.log(`  remaining_percent invalid:  ${issues.impossibleRemaining}`);

if (samples.length > 0) {
  console.log("\nsample corrections:");
  console.log(samples.join("\n"));
}

if (fixes.length === 0) {
  console.log("\nnothing to fix.");
  await sql.end();
  process.exit(0);
}

if (!APPLY) {
  console.log(`\n${fixes.length} rows would change. Re-run with --apply to write.`);
  await sql.end();
  process.exit(0);
}

let written = 0;
for (const f of fixes) {
  await sql`
    update wallet_tokens
    set multiple_x = ${f.newX}, roi_percent = ${f.newRoi}
    where wallet_id = ${f.wallet_id} and token_id = ${f.token_id}`;
  written++;
}
console.log(`\nupdated ${written} rows.`);
await sql.end();
