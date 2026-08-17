/**
 * Root-cause fix for the "impossible mcap" bug (TRUMP at $66.79B, Pnut
 * wallets showing $198M/$400M avg entries that didn't line up with reality).
 *
 * estimatedSupply used to be reverse-engineered as marketCap/price from
 * whichever pool reported the highest liquidity. Some tokens carry
 * long-abandoned pools with near-zero liquidity that still report a price
 * (Pnut had one pool with $0.88 of liquidity pricing it 32x above every real
 * pool) — if a scan ever let one of those through, every wallet recorded in
 * that scan inherited a poisoned mcap multiplier. The code (solanaTracker.ts)
 * now fetches real supply from the chain via getTokenSupply instead, which
 * can't be fooled by a bad pool. This script applies that same real supply to
 * every already-stored row, recomputing avg_buy_mcap_usd / avg_sell_mcap_usd
 * from the (unaffected — these come from real buy/sell USD volume, not any
 * pool price) avg_buy_price_usd / avg_sell_price_usd already on each row.
 *
 * Nothing is deleted: the corrupted field was always a derived display value,
 * never the underlying realized PNL or volume data.
 *
 * Usage: node scripts/backfill-real-supply.mjs [--apply]
 */
import postgres from "postgres";

const url = process.env.POSTGRES_URL_NON_POOLING || process.env.POSTGRES_URL;
if (!url) {
  console.error("No POSTGRES_URL_NON_POOLING / POSTGRES_URL in env.");
  process.exit(1);
}
const RPC_URL = "https://api.mainnet-beta.solana.com";
const ST_BASE = "https://data.solanatracker.io";
const MIN_POOL_LIQUIDITY_USD = 1000;
const apply = process.argv.includes("--apply");
const sql = postgres(url, { prepare: false, max: 1 });

async function fetchTokenSupply(mint) {
  const res = await fetch(RPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getTokenSupply", params: [mint] }),
  });
  const data = await res.json();
  return data?.result?.value?.uiAmount ?? 0;
}

/** Same liquidity-floor + highest-liquidity selection as the fixed
 * fetchTokenMeta, so the refreshed price can't be poisoned by a dust pool
 * either. The stored tokens.price_usd snapshot is never trusted here — Pnut's
 * was stuck at $0.0000000407 (a stale, six-orders-of-magnitude-off snapshot),
 * so every token's price/mcap is refetched fresh instead of "corrected" from
 * a number that might itself already be wrong. */
async function fetchLivePrice(mint) {
  const key = process.env.SOLANA_TRACKER_API_KEY;
  if (!key) return null;
  const res = await fetch(`${ST_BASE}/tokens/${mint}`, { headers: { "x-api-key": key } });
  if (!res.ok) return null;
  const data = await res.json();
  const liquid = (data.pools ?? []).filter((p) => (p.liquidity?.usd ?? 0) >= MIN_POOL_LIQUIDITY_USD);
  const candidates = liquid.length > 0 ? liquid : data.pools ?? [];
  const primary = candidates.slice().sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];
  return primary?.price?.usd ?? null;
}

try {
  const tokens = await sql`select id, address, symbol, price_usd, market_cap_usd from tokens where chain = 'solana'`;

  for (const t of tokens) {
    const realSupply = await fetchTokenSupply(t.address);
    if (!realSupply) {
      console.log(`${t.symbol}: could not fetch on-chain supply, skipping`);
      continue;
    }
    const livePrice = await fetchLivePrice(t.address);
    const correctMcap = livePrice !== null ? livePrice * realSupply : null;

    console.log(
      `${t.symbol}: stored price=${t.price_usd} mcap=${Math.round(t.market_cap_usd ?? 0).toLocaleString()} | ` +
        `real supply=${Math.round(realSupply).toLocaleString()} live price=${livePrice} ` +
        (correctMcap !== null ? `corrected mcap=${Math.round(correctMcap).toLocaleString()}` : "(no live price, token snapshot left alone)")
    );

    if (!apply) continue;

    if (correctMcap !== null) {
      await sql`update tokens set price_usd = ${livePrice}, market_cap_usd = ${correctMcap} where id = ${t.id}`;
    }

    const updated = await sql`
      update wallet_tokens
      set avg_buy_mcap_usd = avg_buy_price_usd * ${realSupply},
          avg_sell_mcap_usd = avg_sell_price_usd * ${realSupply}
      where token_id = ${t.id}
      returning wallet_id
    `;
    console.log(`  updated ${updated.length} wallet_tokens rows`);
  }

  if (!apply) console.log("\nDry run. Re-run with --apply to write.");
} finally {
  await sql.end();
}
