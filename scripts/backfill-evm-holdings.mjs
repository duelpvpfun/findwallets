// Rewrites stored EVM holding data from on-chain balances.
//
// Birdeye's top_traders `unrealizedPnl` is derived from buy/sell volume inside
// the ranking window, so tokens moved out by transfer (or sold outside the
// window) were recorded as still held. Every bsc/base row written before the
// balanceOf fix carries that inflated figure. This reads the real balance and
// rewrites remaining_percent / remaining_value_usd / unrealized_pnl_usd.
//
// Usage: node --env-file=.env.local scripts/backfill-evm-holdings.mjs [--apply]
// Without --apply it only reports what would change.

import postgres from "postgres";

const APPLY = process.argv.includes("--apply");
const RPC = {
  bsc: process.env.BSC_RPC_URL || "https://bsc-dataseed.binance.org",
  base: process.env.BASE_RPC_URL || "https://mainnet.base.org",
};
// Public-node ceilings, confirmed live: BSC -32005 above ~20, Base -32014
// ("maximum 10 calls in 1 batch") plus -32016 throttling at 10.
const BATCH_SIZE = { bsc: 20, base: 5 };
const MAX_ATTEMPTS = 6;
const RATE_LIMIT_CODES = new Set([-32005, -32016]);

const sql = postgres(process.env.POSTGRES_URL_NON_POOLING, { ssl: "require" });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function rpcBatch(chain, calls) {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(RPC[chain], {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(
        calls.map((c, i) => ({
          jsonrpc: "2.0",
          id: i,
          method: "eth_call",
          params: [{ to: c.to, data: c.data }, "latest"],
        }))
      ),
    });
    if (!res.ok) throw new Error(`RPC ${chain} ${res.status}`);
    const body = await res.json();
    const list = Array.isArray(body) ? body : [body];

    if (list.some((r) => r.error && RATE_LIMIT_CODES.has(r.error.code))) {
      if (attempt >= MAX_ATTEMPTS) throw new Error(`RPC ${chain} rate limited`);
      await sleep(600 * 2 ** (attempt - 1));
      continue;
    }

    const out = new Array(calls.length).fill(null);
    for (const item of list) {
      if (typeof item.id === "number" && item.result) out[item.id] = item.result;
    }
    return out;
  }
}

const tokens = await sql`
  select t.id, t.chain, t.address, t.symbol, t.price_usd
  from tokens t
  where t.chain in ('bsc','base')
  order by t.symbol`;

let changed = 0;
let cleared = 0;
let unknown = 0;

for (const token of tokens) {
  // No token amounts are stored, so the bought quantity is reconstructed from
  // gross USD spent over the average buy price.
  const rows = await sql`
    select wt.wallet_id, w.address as wallet, wt.bought_usd,
           wt.avg_buy_price_usd, wt.unrealized_pnl_usd
    from wallet_tokens wt
    join wallets w on w.id = wt.wallet_id
    where wt.token_id = ${token.id}`;
  if (rows.length === 0) continue;

  const [decHex] = await rpcBatch(token.chain, [{ to: token.address, data: "0x313ce567" }]);
  if (!decHex || decHex === "0x") {
    console.log(`! ${token.symbol}: cannot read decimals, skipping`);
    continue;
  }
  const decimals = Number(BigInt(decHex));
  const price = Number(token.price_usd) || 0;

  const size = BATCH_SIZE[token.chain];
  for (let start = 0; start < rows.length; start += size) {
    const slice = rows.slice(start, start + size);
    const results = await rpcBatch(
      token.chain,
      slice.map((r) => ({
        to: token.address,
        data: "0x70a08231" + r.wallet.slice(2).toLowerCase().padStart(64, "0"),
      }))
    );

    for (let i = 0; i < slice.length; i++) {
      const row = slice[i];
      const hex = results[i];
      if (!hex || hex === "0x") {
        unknown++;
        if (unknown <= 3) console.log(`  ? unreadable ${token.chain} ${row.wallet} -> ${hex}`);
        continue;
      }
      const balance = Number(BigInt(hex)) / 10 ** decimals;
      const avgBuy = Number(row.avg_buy_price_usd) || 0;
      const bought = avgBuy > 0 ? (Number(row.bought_usd) || 0) / avgBuy : 0;
      const remainingValue = balance * price;
      const unrealized = balance > 0 ? remainingValue - balance * avgBuy : 0;
      const remainingPercent = bought > 0 ? Math.min(100, (balance / bought) * 100) : 0;

      const before = Number(row.unrealized_pnl_usd) || 0;
      if (Math.abs(before - unrealized) > 0.01) {
        changed++;
        if (balance === 0 && before > 0) cleared++;
      }

      if (APPLY) {
        await sql`
          update wallet_tokens
          set remaining_percent = ${remainingPercent},
              remaining_value_usd = ${remainingValue},
              unrealized_pnl_usd = ${unrealized}
          where wallet_id = ${row.wallet_id} and token_id = ${token.id}`;
      }
    }
    await sleep(150);
  }
  console.log(`${token.symbol} (${token.chain}): ${rows.length} rows checked`);
}

console.log(
  `\n${APPLY ? "APPLIED" : "DRY RUN"} — ${changed} rows differ, ${cleared} phantom positions cleared, ${unknown} unreadable`
);
await sql.end();
