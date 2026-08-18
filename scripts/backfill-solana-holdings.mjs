// Rewrites stored Solana holding data from on-chain balances.
//
// SolanaTracker reports a position's `current.value` as of when the scan ran.
// That snapshot never expires in our table, so a wallet that has since dumped
// its bag still renders as holding one — the same class of phantom the EVM
// balanceOf fix removed, arriving by a different route (staleness rather than
// window-derived math). Confirmed live: 3 of 6 sampled Solana wallets claimed
// four-to-five-figure positions with zero tokens on chain.
//
// Usage: node --env-file=.env.local scripts/backfill-solana-holdings.mjs [--apply]
// Without --apply it only reports what would change.

import postgres from "postgres";

const APPLY = process.argv.includes("--apply");
const RPC = process.env.HELIUS_API_KEY
  ? `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`
  : process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";

const BATCH_SIZE = 10;
const MAX_ATTEMPTS = 6;

const sql = postgres(process.env.POSTGRES_URL_NON_POOLING, { ssl: "require" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function rpcBatch(calls) {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(RPC, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(calls.map((c, i) => ({ jsonrpc: "2.0", id: i, ...c }))),
    });
    if (res.status === 429 || res.status >= 500) {
      if (attempt >= MAX_ATTEMPTS) throw new Error(`RPC ${res.status}`);
      await sleep(600 * 2 ** (attempt - 1));
      continue;
    }
    if (!res.ok) throw new Error(`RPC ${res.status}`);
    const body = await res.json();
    const list = Array.isArray(body) ? body : [body];

    if (list.some((r) => r.error && r.error.code === 429)) {
      if (attempt >= MAX_ATTEMPTS) throw new Error("RPC rate limited");
      await sleep(600 * 2 ** (attempt - 1));
      continue;
    }

    const out = new Array(calls.length).fill(null);
    for (const item of list) {
      if (typeof item.id === "number" && item.result !== undefined) out[item.id] = item.result;
    }
    return out;
  }
}

const tokens = await sql`
  select id, address, symbol, price_usd from tokens where chain = 'solana' order by symbol`;

let changed = 0;
let cleared = 0;
let unknown = 0;

for (const token of tokens) {
  const rows = await sql`
    select wt.wallet_id, w.address as wallet, wt.bought_usd,
           wt.avg_buy_price_usd, wt.unrealized_pnl_usd, wt.remaining_value_usd
    from wallet_tokens wt
    join wallets w on w.id = wt.wallet_id
    where wt.token_id = ${token.id}`;
  if (rows.length === 0) continue;

  const price = Number(token.price_usd) || 0;

  for (let start = 0; start < rows.length; start += BATCH_SIZE) {
    const slice = rows.slice(start, start + BATCH_SIZE);
    const results = await rpcBatch(
      slice.map((r) => ({
        method: "getTokenAccountsByOwner",
        params: [r.wallet, { mint: token.address }, { encoding: "jsonParsed" }],
      }))
    );

    for (let i = 0; i < slice.length; i++) {
      const row = slice[i];
      const result = results[i];
      if (!result || !Array.isArray(result.value)) {
        unknown++;
        continue;
      }

      // A wallet with no token account for this mint holds exactly zero.
      const balance = result.value.reduce(
        (sum, acc) => sum + (acc.account?.data?.parsed?.info?.tokenAmount?.uiAmount || 0),
        0
      );
      const avgBuy = Number(row.avg_buy_price_usd) || 0;
      const bought = avgBuy > 0 ? (Number(row.bought_usd) || 0) / avgBuy : 0;
      const remainingValue = balance * price;
      const unrealized = balance > 0 ? remainingValue - balance * avgBuy : 0;
      const remainingPercent = bought > 0 ? Math.min(100, (balance / bought) * 100) : 0;

      const beforeValue = Number(row.remaining_value_usd) || 0;
      if (Math.abs(beforeValue - remainingValue) > 0.01) {
        changed++;
        if (balance === 0 && beforeValue > 0) cleared++;
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
  console.log(`${token.symbol}: ${rows.length} rows checked`);
}

console.log(
  `\n${APPLY ? "APPLIED" : "DRY RUN"} — ${changed} rows differ, ${cleared} phantom positions cleared, ${unknown} unreadable`
);
await sql.end();
