// Imports a curated list of named traders into `wallets`, so a scan can call a
// wallet by its name and link its X account instead of showing 44 base58
// characters.
//
// Why this is an import and not enrichment: our paid upstreams only attach an
// identity on Solana, and only sometimes. Birdeye returns none at all, so every
// BNB Chain and Base row rendered as a bare address even when the wallet belongs
// to someone with 300k followers. The names have to come from somewhere else.
//
// One FOMO account owns one Solana address and one EVM address, and the EVM
// address is live on both chains we rank, so each entry writes up to three rows:
// solana, bsc, base. EVM addresses are stored lowercased — `fetchWalletIdentities`
// matches them case-insensitively, since providers disagree on checksumming.
//
// Nothing here touches trade data. These rows carry no PNL, no wins and no tags:
// `identity_source` is the only thing being asserted, which is why
// `purge-noncompliant.mjs` leaves them alone.
//
// Usage:
//   node --env-file=.env.local scripts/import-kol-wallets.mjs                     # data/fomo-kols.json
//   node --env-file=.env.local scripts/import-kol-wallets.mjs path/to/dump.json
//   node --env-file=.env.local scripts/import-kol-wallets.mjs --dry-run

import fs from "node:fs";
import postgres from "postgres";

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const file = args.find((a) => !a.startsWith("--")) ?? "data/fomo-kols.json";
// Marks the row as a curated directory entry rather than a scan leftover.
const SOURCE = "fomo";

const SOLANA_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

const url = process.env.POSTGRES_URL_NON_POOLING || process.env.POSTGRES_URL;
if (!url) {
  console.error("No POSTGRES_URL_NON_POOLING / POSTGRES_URL in env.");
  process.exit(1);
}

/** Stored as `@handle`, which is the shape every scan-derived row in the column
 *  already has, and what the UI renders as link text. The URL is built at render
 *  time, so storing a full URL here would produce x.com/https://x.com/foo. */
function twitterHandle(raw) {
  if (!raw) return null;
  const handle = String(raw)
    .trim()
    .replace(/^https?:\/\/(www\.)?(x|twitter)\.com\//i, "")
    .replace(/^@/, "")
    .replace(/[/?].*$/, "");
  return /^[A-Za-z0-9_]{1,15}$/.test(handle) ? `@${handle}` : null;
}

const entries = JSON.parse(fs.readFileSync(file, "utf8"));
if (!Array.isArray(entries)) {
  console.error(`${file} is not a JSON array.`);
  process.exit(1);
}

// Keyed by DB column name so the rows can go straight into the insert helper.
const rows = [];
const skipped = [];
for (const e of entries) {
  // `handle` is the FOMO username: ASCII, stable, and the thing people
  // recognise. `displayName` in the same dump is emoji-laden and arrives
  // mis-encoded, so it is deliberately ignored.
  const identity_name = typeof e?.handle === "string" ? e.handle.trim() : "";
  if (!identity_name) {
    skipped.push(`no handle: ${JSON.stringify(e).slice(0, 80)}`);
    continue;
  }
  const twitter = twitterHandle(e.twitter);
  const row = (chain, address) => ({
    chain,
    address,
    identity_name,
    twitter,
    identity_source: SOURCE,
  });
  let addresses = 0;

  if (typeof e.address === "string" && SOLANA_ADDRESS.test(e.address)) {
    rows.push(row("solana", e.address));
    addresses++;
  } else if (e.address) {
    skipped.push(`${identity_name}: bad solana address ${e.address}`);
  }

  if (typeof e.evmAddress === "string" && EVM_ADDRESS.test(e.evmAddress)) {
    const evm = e.evmAddress.toLowerCase();
    rows.push(row("bsc", evm), row("base", evm), row("robinhood", evm));
    addresses++;
  } else if (e.evmAddress) {
    skipped.push(`${identity_name}: bad evm address ${e.evmAddress}`);
  }

  if (addresses === 0) skipped.push(`${identity_name}: no usable address`);
}

const identities = new Set(rows.map((r) => r.identity_name));
const withHandle = new Set(rows.filter((r) => r.twitter).map((r) => r.identity_name));
console.log(`${file}: ${entries.length} entries -> ${rows.length} rows`);
console.log(`  ${identities.size} identities, ${withHandle.size} with an X handle`);
for (const s of skipped) console.log(`  skipped ${s}`);

if (rows.length === 0) process.exit(0);

if (DRY_RUN) {
  for (const r of rows.slice(0, 6)) {
    console.log(`  ${r.chain} ${r.address} -> ${r.identity_name}${r.twitter ? ` ${r.twitter}` : ""}`);
  }
  console.log("\nDry run. Nothing written. Re-run without --dry-run to apply.");
  process.exit(0);
}

const sql = postgres(url, { ssl: "require", prepare: false });

// One statement, not one insert per row: a fan-out of hundreds of concurrent
// queries is what makes the pooler stop answering.
//
// A wallet already known from a scan keeps everything it has learned — only the
// name, handle and source are written. `last_seen_at` and `times_seen` are left
// alone on purpose: an import is not a sighting, and inflating "seen in N scans"
// would put a number in front of a paying customer that no scan produced.
const written = await sql`
  insert into wallets ${sql(rows, "chain", "address", "identity_name", "twitter", "identity_source")}
  on conflict (chain, address) do update set
    identity_name = excluded.identity_name,
    twitter = coalesce(excluded.twitter, wallets.twitter),
    identity_source = excluded.identity_source
  returning (xmax = 0) as inserted`;

const inserted = written.filter((r) => r.inserted).length;
console.log(`\nwallets — ${inserted} new, ${written.length - inserted} updated`);

const [total] = await sql`
  select count(*)::int as n from wallets where identity_source = ${SOURCE}`;
const byChain = await sql`
  select chain, count(*)::int as n from wallets
  where identity_source = ${SOURCE} group by 1 order by 1`;
console.log(`  ${total.n} curated rows: ${byChain.map((r) => `${r.chain} ${r.n}`).join(" · ")}`);

await sql.end();
