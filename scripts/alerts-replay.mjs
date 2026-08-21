// Drives the alert stream with real data, against a running server.
//
//   node --env-file=.env.local scripts/alerts-replay.mjs --classify        # dry, no POST
//   node --env-file=.env.local scripts/alerts-replay.mjs --wallets 8       # replay real txs
//   node --env-file=.env.local scripts/alerts-replay.mjs --simulate        # force an alert
//   ...                                        --url https://your-preview.vercel.app
//
// Three modes, for the three things that can be wrong:
//
//   --classify  Is the buy/sell classification right? Pulls recent transactions
//               for roster wallets straight from Helius and prints what the
//               route would make of each one, with a Solscan link per event so
//               it can be checked by hand. This is the gate the plan calls step
//               2: landing the transactions correctly is the hard part.
//
//   --wallets   The same transactions, actually POSTed. Proves auth, parsing,
//               dedupe and persistence. Safe to re-run — the unique index makes
//               a second pass a no-op, which is itself worth confirming.
//
//   --simulate  Synthesises a Helius payload in which two real roster wallets
//               buy one real token seconds apart. The only way to exercise
//               escalation, the market-cap snapshot and Telegram delivery
//               without waiting for it to happen naturally.
//
// --simulate writes real rows to wallet_events and alerts_fired, and posts to
// whatever Telegram chat is configured. Point it at a dev server, and clean up
// with --undo when finished.
import postgres from "postgres";

const args = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? (args[i + 1]?.startsWith("--") ? true : args[i + 1]) : fallback;
};

const CLASSIFY_ONLY = args.includes("--classify");
const SIMULATE = args.includes("--simulate");
const UNDO = args.includes("--undo");
const BASE = flag("url", "http://localhost:3000");
const WALLET_COUNT = Number(flag("wallets", 6)) || 6;

/**
 * The token --simulate pretends was bought. Override with --mint.
 *
 * Must NOT be a quote or bluechip mint: WSOL, USDC and the liquid-staking mints
 * are in `IGNORED_SUBJECT_MINTS`, so the classifier correctly refuses to treat
 * one as the subject of a trade and the simulation would silently do nothing.
 * Defaults to BONK — a real, liquid memecoin, so the market-cap snapshot has
 * something genuine to pin.
 */
const SIMULATE_MINT = flag("mint", "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263");

const url = process.env.POSTGRES_URL_NON_POOLING || process.env.POSTGRES_URL;
const sql = postgres(url, { prepare: false, max: 2 });

const HELIUS_KEY = process.env.HELIUS_API_KEY;
const SECRET = process.env.HELIUS_WEBHOOK_SECRET;

async function rosterSample(limit) {
  return sql`
    select address, label, avg_multiple_x, avg_pnl_usd
    from alert_wallets
    where chain = 'solana' and active = true
    order by best_multiple_x desc nulls last
    limit ${limit}
  `;
}

async function post(payload) {
  const res = await fetch(`${BASE}/api/stream/solana`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${SECRET}` },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  return { status: res.status, body: text.slice(0, 400) };
}

async function recentTransactions(address, limit = 15) {
  const res = await fetch(
    `https://api.helius.xyz/v0/addresses/${address}/transactions?api-key=${HELIUS_KEY}&limit=${limit}`
  );
  if (!res.ok) return [];
  return res.json();
}

// --- --undo ---

if (UNDO) {
  const events = await sql`
    delete from wallet_events
    where chain = 'solana' and tx_signature like 'SIMULATED%'
    returning id
  `;
  const alerts = await sql`
    delete from alerts_fired
    where chain = 'solana' and token_address = ${SIMULATE_MINT}
    returning id
  `;
  const state = await sql`
    delete from alert_state where chain = 'solana' and token_address = ${SIMULATE_MINT}
    returning token_address
  `;
  console.log(`removed ${events.length} simulated events, ${alerts.length} alerts, ${state.length} state rows`);
  await sql.end();
  process.exit(0);
}

// --- --simulate ---

if (SIMULATE) {
  const wallets = await rosterSample(4);
  if (wallets.length < 2) {
    console.error("Need at least 2 roster wallets. Run alerts:sync first.");
    process.exit(1);
  }

  // A minimal but structurally real enhanced transaction: SOL out of the main
  // account, the token in on an owned ATA. That is exactly the shape the
  // classifier reads, so this exercises the real code path rather than a stub.
  const now = Math.floor(Date.now() / 1000);
  const build = (wallet, index, solOut) => ({
    signature: `SIMULATED${index}${now}${"x".repeat(40)}`,
    timestamp: now - (2 - index) * 20,
    type: "SWAP",
    source: "JUPITER",
    fee: 5000,
    feePayer: wallet.address,
    transactionError: null,
    accountData: [
      {
        account: wallet.address,
        nativeBalanceChange: -Math.round(solOut * 1e9) - 5000,
        tokenBalanceChanges: [],
      },
      {
        account: `ATA${index}`,
        nativeBalanceChange: 0,
        tokenBalanceChanges: [
          {
            userAccount: wallet.address,
            tokenAccount: `ATA${index}`,
            rawTokenAmount: { tokenAmount: String(1_000_000 * (index + 1)), decimals: 6 },
            mint: SIMULATE_MINT,
          },
        ],
      },
    ],
    tokenTransfers: [],
  });

  console.log(`simulating ${wallets.length >= 3 ? 3 : 2} buys of ${SIMULATE_MINT}`);
  for (const [i, wallet] of wallets.slice(0, 3).entries()) {
    const result = await post([build(wallet, i, 2 + i)]);
    const name = wallet.label || wallet.address.slice(0, 8);
    console.log(`  ${i + 1}. ${name}  ->  ${result.status} ${result.body}`);
  }

  const fired = await sql`
    select tier, wallet_count, span_seconds, mcap_at_alert_usd, token_symbol,
           delivered_at, delivery_error
    from alerts_fired
    where chain = 'solana' and token_address = ${SIMULATE_MINT} and superseded = false
    order by id desc limit 5
  `;
  console.log("\nalerts_fired:");
  for (const row of fired) {
    console.log(
      `  tier ${row.tier}  ${row.wallet_count} wallets  span ${row.span_seconds}s  ` +
        `${row.token_symbol ?? "?"}  mcap ${row.mcap_at_alert_usd?.toFixed(0) ?? "—"}  ` +
        `${row.delivered_at ? "delivered" : row.delivery_error ?? "not sent"}`
    );
  }
  if (fired.length === 0) console.log("  (none — check the server log)");
  console.log("\nclean up with: --undo");
  await sql.end();
  process.exit(0);
}

// --- --classify / --wallets ---

const wallets = await rosterSample(WALLET_COUNT);
console.log(`pulling recent transactions for ${wallets.length} roster wallets…\n`);

let totalTx = 0;
const batches = [];
for (const wallet of wallets) {
  const txs = await recentTransactions(wallet.address);
  totalTx += txs.length;
  batches.push({ wallet, txs });
}

if (CLASSIFY_ONLY) {
  // Mirrors src/lib/alerts/classify.ts. Kept deliberately small and separate:
  // this is a second opinion for eyeballing, not the implementation.
  const QUOTES = new Set([
    "So11111111111111111111111111111111111111112",
    "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
  ]);
  const SOL = 91;
  let buys = 0;
  let sells = 0;

  for (const { wallet, txs } of batches) {
    for (const tx of txs) {
      if (tx.transactionError) continue;
      let lamports = 0;
      const deltas = new Map();
      for (const a of tx.accountData ?? []) {
        if (a.account === wallet.address) lamports += a.nativeBalanceChange ?? 0;
        for (const c of a.tokenBalanceChanges ?? []) {
          if (c.userAccount !== wallet.address) continue;
          const amt = Number(c.rawTokenAmount?.tokenAmount ?? 0) / 10 ** (c.rawTokenAmount?.decimals ?? 0);
          deltas.set(c.mint, (deltas.get(c.mint) ?? 0) + amt);
        }
      }
      if (tx.feePayer === wallet.address) lamports += tx.fee ?? 0;
      let quoteUsd = (lamports / 1e9) * SOL;
      for (const m of ["EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB"]) {
        quoteUsd += deltas.get(m) ?? 0;
      }
      const subjects = [...deltas].filter(([m, v]) => !QUOTES.has(m) && Math.abs(v) > 1e-9);
      const side = quoteUsd < 0 ? "buy" : "sell";
      const match = subjects.filter(([, v]) => (side === "buy" ? v > 0 : v < 0));
      if (match.length !== 1 || Math.abs(quoteUsd) < 1) continue;

      side === "buy" ? buys++ : sells++;
      const name = wallet.label || wallet.address.slice(0, 6);
      console.log(
        `${side === "buy" ? "BUY " : "SELL"}  $${Math.abs(quoteUsd).toFixed(0).padStart(7)}  ` +
          `${name.padEnd(14)}  ${match[0][0]}\n      ${tx.type}/${tx.source}  ` +
          `https://solscan.io/tx/${tx.signature}`
      );
    }
  }
  console.log(`\n${totalTx} transactions -> ${buys} buys, ${sells} sells`);
  console.log("Spot-check a few against Solscan before trusting the aggregate.");
  await sql.end();
  process.exit(0);
}

console.log(`POSTing ${totalTx} transactions to ${BASE}/api/stream/solana`);
for (const { wallet, txs } of batches) {
  if (txs.length === 0) continue;
  const result = await post(txs);
  console.log(`  ${(wallet.label || wallet.address.slice(0, 8)).padEnd(16)} ${result.status} ${result.body}`);
}

const [stored] = await sql`
  select count(*)::int as total,
         count(*) filter (where side = 'buy')::int as buys,
         count(*) filter (where side = 'sell')::int as sells,
         count(distinct token_address)::int as tokens
  from wallet_events where chain = 'solana'
`;
console.log(`\nwallet_events: ${stored.total} rows (${stored.buys} buys, ${stored.sells} sells) across ${stored.tokens} tokens`);
await sql.end();
