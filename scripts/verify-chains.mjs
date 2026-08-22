// Exercises the real /api/top-traders route for one token per chain and checks
// every row for internal consistency. Verifies what customers actually receive,
// including that what got written to the database matches what was served.
//
// Requires the dev server running on :3000.
// Usage: node --env-file=.env.local scripts/verify-chains.mjs

import postgres from "postgres";

const BASE = process.env.VERIFY_BASE_URL || "http://localhost:3000";
const OWNER = process.env.OWNER_ACCESS_KEY;

const TOKENS = [
  { chain: "solana", address: "RmtMAYVTTFv2iK9muMrXEoAnSSsZPPgRPbqZCKwNDYk" },
  { chain: "bsc", address: "0x8b7abC1C0F2e6C0b76BC4FD0F7190f67d72E7777" },
  { chain: "base", address: "0xB2000000000000000000004c27f6523082f41D01" },
  { chain: "robinhood", address: "0x020bfC650A365f8BB26819deAAbF3E21291018b4" },
];

const NATIVE = { solana: "SOL", bsc: "BNB", base: "ETH", robinhood: "ETH" };
const sql = postgres(process.env.POSTGRES_URL_NON_POOLING, { ssl: "require", prepare: false });

const usd = (v) => {
  if (v === null || v === undefined) return "null";
  const a = Math.abs(v);
  const s = v < 0 ? "-" : "";
  if (a >= 1e6) return `${s}$${(a / 1e6).toFixed(2)}M`;
  if (a >= 1e3) return `${s}$${(a / 1e3).toFixed(1)}K`;
  return `${s}$${a.toFixed(2)}`;
};

let problems = 0;
const fail = (msg) => {
  problems++;
  console.log(`   ✗ ${msg}`);
};

for (const { chain, address } of TOKENS) {
  console.log(`\n${"=".repeat(78)}\n${chain.toUpperCase()}  ${address}\n${"=".repeat(78)}`);

  const res = await fetch(`${BASE}/api/top-traders?chain=${chain}&address=${address}&limit=50`, {
    headers: { "x-owner-key": OWNER },
  });
  const body = await res.json();

  if (!res.ok) {
    fail(`HTTP ${res.status}: ${JSON.stringify(body).slice(0, 200)}`);
    continue;
  }
  if (body.isDemoData) {
    fail("served DEMO data — API key missing for this chain");
    continue;
  }

  const { token, traders } = body;
  console.log(`token: ${token.symbol} "${token.name}"`);
  console.log(`  price=$${token.priceUsd}  mcap=${usd(token.marketCapUsd)}  supply=${token.estimatedSupply?.toExponential(4)}`);
  console.log(`  native(${NATIVE[chain]})=$${token.nativePriceUsd}  window=${token.rankingWindow}  market=${token.market}`);
  console.log(`  traders returned: ${traders.length}`);

  // --- token-level sanity
  if (!(token.priceUsd > 0)) fail(`token price is ${token.priceUsd}`);
  if (!(token.nativePriceUsd > 0)) fail(`native price is ${token.nativePriceUsd} — "remaining in ${NATIVE[chain]}" would divide by zero`);
  if (!(token.estimatedSupply > 0)) fail(`estimatedSupply is ${token.estimatedSupply} — every mcap would be 0`);
  if (token.marketCapUsd > 0 && token.estimatedSupply > 0) {
    const implied = token.priceUsd * token.estimatedSupply;
    const drift = Math.abs(implied - token.marketCapUsd) / token.marketCapUsd;
    if (drift > 0.05) fail(`mcap ${usd(token.marketCapUsd)} != price*supply ${usd(implied)} (${(drift * 100).toFixed(1)}% off)`);
  }
  if (chain === "solana" && token.rankingWindow !== "all_time") fail(`solana window should be all_time, got ${token.rankingWindow}`);
  if (chain !== "solana" && token.rankingWindow === "all_time") fail(`${chain} cannot do all_time (Birdeye 400s)`);
  if (traders.length === 0) {
    fail("zero traders");
    continue;
  }

  // --- per-row consistency
  let pnlMismatch = 0, xMismatch = 0, negRemaining = 0, badPct = 0, nullPos = 0, movedOut = 0;
  for (const t of traders) {
    // PnL % and multiple must agree with each other: X = 1 + pct/100.
    const impliedX = 1 + t.realizedPnlPercent / 100;
    if (t.avgMultipleX !== null && Math.abs(impliedX - t.avgMultipleX) > 0.02 * Math.max(1, Math.abs(t.avgMultipleX))) xMismatch++;

    // The multiple must be PnL over the cost of the tokens sold.
    const basis = t.soldCostBasisUsd >= 100 ? t.soldCostBasisUsd : Math.max(t.soldCostBasisUsd, t.boughtUsd);
    if (basis > 0) {
      const expect = 1 + t.realizedPnlUsd / basis;
      if (t.avgMultipleX !== null && Math.abs(expect - t.avgMultipleX) > 0.02 * Math.max(1, Math.abs(expect))) pnlMismatch++;
    }

    if (t.remainingPercent !== null && (t.remainingPercent < 0 || t.remainingPercent > 100)) negRemaining++;
    if (t.remainingPercent === null) nullPos++;
    if (t.transferredOutPercent !== null && t.transferredOutPercent >= 1) movedOut++;
    if (!Number.isFinite(t.realizedPnlUsd) || (t.avgMultipleX !== null && !Number.isFinite(t.avgMultipleX))) badPct++;
    // Avg entry price must be plausible against the current price (within 1000x).
    if (t.avgBuyPriceUsd > 0 && token.priceUsd > 0) {
      const r = t.avgBuyPriceUsd / token.priceUsd;
      if (r > 1000 || r < 0.001) badPct++;
    }
  }

  if (xMismatch) fail(`${xMismatch}/${traders.length} rows: % and X disagree`);
  if (pnlMismatch) fail(`${pnlMismatch}/${traders.length} rows: X != 1 + pnl/soldCostBasis`);
  if (negRemaining) fail(`${negRemaining} rows: remainingPercent out of 0..100`);
  if (badPct) fail(`${badPct} rows: non-finite or implausible price`);
  console.log(`  consistency: ${traders.length - xMismatch - pnlMismatch} rows internally consistent`);
  console.log(`  positions: ${nullPos} unknown, ${movedOut} with >=1% transferred out`);

  // --- top 3 rows, exactly as the table renders them
  console.log("\n  top rows as rendered:");
  for (const t of traders.slice(0, 3)) {
    const soldShare = t.boughtTokenAmount > 0
      ? (Math.min(t.soldTokenAmount, t.boughtTokenAmount) / t.boughtTokenAmount) * 100 : 0;
    const nat = token.nativePriceUsd > 0 && t.remainingValueUsd !== null
      ? (t.remainingValueUsd / token.nativePriceUsd).toFixed(4) : "—";
    console.log(
      `   ${t.address.slice(0, 6)}…${t.address.slice(-4)} ${t.avgMultipleX === null ? "n/a" : t.avgMultipleX.toFixed(2) + "x"} ${usd(t.realizedPnlUsd)} ` +
      `(${t.realizedPnlPercent >= 0 ? "+" : ""}${t.realizedPnlPercent.toFixed(1)}%)`
    );
    console.log(
      `      bought ${usd(t.boughtUsd)} -> sold ${usd(t.soldUsd)} | entry $${t.avgBuyPriceUsd.toPrecision(3)} -> exit $${t.avgSellPriceUsd.toPrecision(3)}`
    );
    console.log(
      `      mcap ${usd(t.avgBuyMcapUsd)} -> ${usd(t.avgSellMcapUsd)} | sold ${soldShare.toFixed(1)}% of bag` +
      `${t.transferredOutPercent !== null && t.transferredOutPercent >= 1 ? ` · ${t.transferredOutPercent.toFixed(0)}% moved out` : ""}`
    );
    console.log(
      `      remaining ${nat} ${NATIVE[chain]} (${t.remainingPercent === null ? "unknown" : t.remainingPercent.toFixed(0) + "%"})` +
      ` | unreal ${usd(t.unrealizedPnlUsd)} | holding=${t.isHolding}`
    );
  }

  // --- did the database record what was served?
  await new Promise((r) => setTimeout(r, 2500));
  const [row] = await sql`
    select t.symbol, t.price_usd, t.native_price_usd, t.market_cap_usd, count(wt.wallet_id) as stored
    from tokens t left join wallet_tokens wt on wt.token_id = t.id
    where t.chain = ${chain} and lower(t.address) = lower(${address})
    group by t.id, t.symbol, t.price_usd, t.native_price_usd, t.market_cap_usd`;

  if (!row) {
    fail("nothing persisted for this token");
  } else {
    const qualifying = traders.filter((t) => t.avgMultipleX >= 2 && t.realizedPnlUsd >= 1000).length;
    console.log(`\n  db: ${row.symbol} price=$${row.price_usd} native=$${row.native_price_usd} rows=${row.stored}`);
    console.log(`      served rows clearing the 2x/$1k bar: ${qualifying}`);
    if (Number(row.stored) < qualifying) fail(`db has ${row.stored} rows but ${qualifying} qualified`);
    if (!(Number(row.native_price_usd) > 0)) fail(`db native_price_usd=${row.native_price_usd}`);
  }
}

console.log(`\n${"=".repeat(78)}`);
console.log(problems === 0 ? "ALL CHECKS PASSED" : `${problems} PROBLEM(S) FOUND`);
await sql.end();
process.exit(problems === 0 ? 0 : 1);
