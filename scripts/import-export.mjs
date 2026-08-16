// Backfills the wallet DB from previously downloaded "highpnl <token>.json" exports.
//
// Those exports only preserved wallet address + multiple + symbol — PNL, entry/exit
// and the token's contract address were never written to the file. Symbols are not
// unique (three different BSC tokens answer to "MARSCOIN"), so the contract address
// must be supplied explicitly rather than guessed.
//
// Usage:
//   node scripts/import-export.mjs "highpnl MarsCoin.json" --chain bsc --token 0xABC…
//   node scripts/import-export.mjs "highpnl MarsCoin.json" --chain bsc --token 0xABC… --commit
//
// Without --commit it performs a dry run and writes nothing.
import fs from "node:fs";
import postgres from "postgres";

const args = process.argv.slice(2);
const file = args[0];
const chain = valueOf("--chain");
const tokenAddress = valueOf("--token");
const commit = args.includes("--commit");

function valueOf(flag) {
  const i = args.indexOf(flag);
  return i === -1 ? null : args[i + 1];
}

if (!file || !chain || !tokenAddress) {
  console.error("Usage: node scripts/import-export.mjs <file.json> --chain <solana|bsc|base> --token <address> [--commit]");
  process.exit(1);
}

const entries = JSON.parse(fs.readFileSync(file, "utf8"));

// "44.36x - MEOW" -> { multiple: 44.36, symbol: "MEOW" }
function parseName(name) {
  const m = /^([\d.]+)x\s+-\s+(.+)$/.exec(name);
  if (!m) return { multiple: null, symbol: null };
  return { multiple: Number(m[1]), symbol: m[2] };
}

const parsed = entries
  .map((e) => ({ address: e.trackedWalletAddress, ...parseName(e.name) }))
  .filter((r) => r.address);

const withMultiple = parsed.filter((r) => r.multiple !== null);
const symbol = parsed.find((r) => r.symbol)?.symbol ?? null;

// Same wallet can appear twice in one file; keep its best multiple.
const byAddress = new Map();
for (const r of parsed) {
  const prev = byAddress.get(r.address);
  if (!prev || (r.multiple ?? 0) > (prev.multiple ?? 0)) byAddress.set(r.address, r);
}
const unique = [...byAddress.values()];

console.log(`file           ${file}`);
console.log(`chain/token    ${chain} ${tokenAddress}`);
console.log(`symbol         ${symbol ?? "(unknown)"}`);
console.log(`entries        ${entries.length}`);
console.log(`unique wallets ${unique.length}`);
console.log(`with multiple  ${withMultiple.length}`);
console.log(`mode           ${commit ? "COMMIT" : "dry run (pass --commit to write)"}`);

if (!commit) process.exit(0);

const sql = postgres(process.env.POSTGRES_URL_NON_POOLING || process.env.POSTGRES_URL, {
  prepare: false,
});

const [token] = await sql`
  insert into tokens (chain, address, symbol, scan_count)
  values (${chain}, ${tokenAddress}, ${symbol}, 1)
  on conflict (chain, address) do update
    set symbol = coalesce(excluded.symbol, tokens.symbol),
        last_scanned_at = now(),
        scan_count = tokens.scan_count + 1
  returning id
`;

let inserted = 0;
let updated = 0;

for (const row of unique) {
  const [wallet] = await sql`
    insert into wallets (chain, address, times_seen)
    values (${chain}, ${row.address}, 1)
    on conflict (chain, address) do update
      set last_seen_at = now(), times_seen = wallets.times_seen + 1
    returning id, times_seen
  `;

  // Imported rows carry no PNL — only the multiple survived the original export.
  const existing = await sql`
    select times_observed from wallet_tokens
    where wallet_id = ${wallet.id} and token_id = ${token.id}
  `;

  if (existing.length > 0) {
    await sql`
      update wallet_tokens
      set multiple_x = greatest(coalesce(multiple_x, 0), ${row.multiple}),
          last_observed_at = now()
      where wallet_id = ${wallet.id} and token_id = ${token.id}
    `;
    updated++;
  } else {
    await sql`
      insert into wallet_tokens
        (wallet_id, token_id, realized_pnl_usd, multiple_x, ranking_window, times_observed)
      values (${wallet.id}, ${token.id}, 0, ${row.multiple}, 'imported', 1)
    `;
    inserted++;
  }
}

console.log(`\ninserted=${inserted} updated=${updated}`);
await sql.end();
