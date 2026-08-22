// Rebuilds the alert roster and pushes it to the Helius webhook.
//
//   node --env-file=.env.local scripts/sync-alert-wallets.mjs            # report only
//   node --env-file=.env.local scripts/sync-alert-wallets.mjs --apply    # write db + helius
//   ...                                             --apply --limit 500  # cap the roster
//   ...                                             --apply --db-only    # skip helius
//
// Two jobs in one script on purpose: the address list Helius holds and the
// `alert_wallets` table have to agree, and splitting them is how they drift.
// The webhook route resolves every incoming address against `alert_wallets`, so
// an address Helius streams that the table does not know is wasted invocations,
// and a wallet in the table that Helius is not watching is silently never
// alerted on.
//
// Run this AFTER deploying the stream route. Helius auto-disables a webhook
// whose receiver keeps failing — that is exactly how the previous webhook on
// this account died.
//
// Cannot import from src/lib (the `server-only` boundary), so the eligibility
// thresholds below are duplicated. They are stated once more in AGENTS.md.
import postgres from "postgres";

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const DB_ONLY = args.includes("--db-only");
const limitArg = args.indexOf("--limit");
const LIMIT = limitArg >= 0 ? Number(args[limitArg + 1]) : null;

const CHAIN = "solana";

/**
 * The owner's eligibility rule, 2026-08-22: **one 5x+ win, and nothing else
 * qualifies.**
 *
 * Replaces the three-path rule of 2026-08-21 ("one 4x+, or multiple 3x+, or 2x+
 * and 5k+ pnl in one coin"), which admitted 1,685 wallets. One 5x+ admits 846 —
 * half the roster gone in one move, and the two paths that go are the ones that
 * let a wallet in on a 2x or on a pair of 3x nobody would have copied.
 *
 * Measured before the change, replaying the live buy stream against both
 * rosters: tokens reaching tier 2 fall from 149 to 98, tokens reaching tier 10
 * from 30 to 11, and **every one of the thirteen calls that ran 1.5x or better
 * still had five or more surviving wallets in it**, so none of them stops
 * firing. Trimming harder was tried and rejected — "one 3x+ AND two wins total"
 * gets to 139 wallets but takes a 1.92x call to zero surviving wallets and three
 * more down to one.
 *
 * Worth knowing before reaching for this lever again: the roster is a weak
 * volume control. Halving it cut calls by a third, while gating the first
 * Telegram post on tier 6 cut messages by 76% on the same night's data. Breadth
 * is what makes confluence detectable at all; the roster is what makes it
 * credible.
 *
 * Deliberately about the QUALITY of a wallet's record rather than how often we
 * happen to have seen it. `times_seen` counts appearances in scans customers
 * paid for, which measures which tokens got scanned at least as much as it
 * measures the wallet.
 */
const MIN_SINGLE_MULTIPLE = 5;

/**
 * Plausibility guard on the rows a wallet qualifies with. Mirrors
 * `MIN_COST_BASIS_USD` and `MAX_PLAUSIBLE_MULTIPLE_X` in src/lib/quality.ts —
 * duplicated here because scripts cannot cross the `server-only` boundary, so
 * change both together.
 *
 * Not optional. Without it the roster's top entries were wallets whose entire
 * claim was one "588x" against a few dollars of dust: tokens that arrived by
 * transfer or airdrop have a real PNL but no basis to measure a return against.
 * Measured on the live database, this excludes 105 of 1,790 wallets — and it
 * matters far more than that number suggests, because `avg_multiple_x` is the
 * headline of every alert those wallets would have appeared in.
 */
const MIN_COST_BASIS_USD = 100;
const MAX_PLAUSIBLE_MULTIPLE_X = 500;

const url = process.env.POSTGRES_URL_NON_POOLING || process.env.DATABASE_URL || process.env.POSTGRES_URL;
if (!url) {
  console.error("No connection string found in env.");
  process.exit(1);
}

const sql = postgres(url, { prepare: false, max: 2 });

/**
 * Eligible wallets, with the track record the alert message quotes.
 *
 * `avg_multiple_x` and `avg_pnl_usd` are means over the wallet's WINS, not over
 * everything it ever touched. That is the honest framing for an alert line that
 * says "avg 5.75x": it is describing what this wallet's good calls look like,
 * which is the question a reader is actually asking. `wallet_tokens` only ever
 * stores rows clearing the 2x/$1,000 bar in the first place, so every row here
 * is already a win.
 */
async function eligibleWallets() {
  return sql`
    select
      w.id as wallet_id,
      w.address,
      w.identity_name,
      w.twitter,
      count(*)::int as token_count,
      avg(wt.multiple_x)::float8 as avg_multiple_x,
      avg(wt.realized_pnl_usd)::float8 as avg_pnl_usd,
      max(wt.multiple_x)::float8 as best_multiple_x,
      max(wt.realized_pnl_usd)::float8 as best_pnl_usd,
      (array_agg(t.symbol order by wt.multiple_x desc nulls last))[1] as best_symbol
    from wallets w
    join wallet_tokens wt on wt.wallet_id = w.id
    join tokens t on t.id = wt.token_id
    where w.chain = ${CHAIN}
      and not w.is_bot
      and wt.multiple_x is not null
      and wt.multiple_x <= ${MAX_PLAUSIBLE_MULTIPLE_X}
      and coalesce(wt.bought_usd, 0) >= ${MIN_COST_BASIS_USD}
    group by w.id, w.address, w.identity_name, w.twitter
    having count(*) filter (where wt.multiple_x >= ${MIN_SINGLE_MULTIPLE}) >= 1
    order by max(wt.multiple_x) desc nulls last
  `;
}

async function syncDatabase(rows) {
  // One multi-row upsert, not a statement per wallet: ~1,700 round trips
  // against a pooled connection is minutes of wall clock for no reason.
  //
  // `sql.json(rows)`, never `JSON.stringify(rows)::jsonb`. postgres.js JSON-encodes
  // a bound value on its way to a jsonb parameter, so a pre-stringified array
  // arrives as a jsonb *string* containing the array — and `jsonb_to_recordset`
  // rejects it with "cannot call jsonb_to_recordset on a non-array".
  await sql`
    insert into alert_wallets (
      chain, address, wallet_id, label, twitter, token_count,
      avg_multiple_x, avg_pnl_usd, best_multiple_x, best_pnl_usd, best_symbol,
      active, synced_at
    )
    select
      ${CHAIN}, x.address, x.wallet_id, x.label, x.twitter, x.token_count,
      x.avg_multiple_x, x.avg_pnl_usd, x.best_multiple_x, x.best_pnl_usd, x.best_symbol,
      true, now()
    from jsonb_to_recordset(${sql.json(rows)}) as x(
      address text, wallet_id int, label text, twitter text, token_count int,
      avg_multiple_x float8, avg_pnl_usd float8, best_multiple_x float8,
      best_pnl_usd float8, best_symbol text
    )
    on conflict (chain, address) do update set
      wallet_id = excluded.wallet_id,
      label = coalesce(excluded.label, alert_wallets.label),
      twitter = coalesce(excluded.twitter, alert_wallets.twitter),
      token_count = excluded.token_count,
      avg_multiple_x = excluded.avg_multiple_x,
      avg_pnl_usd = excluded.avg_pnl_usd,
      best_multiple_x = excluded.best_multiple_x,
      best_pnl_usd = excluded.best_pnl_usd,
      best_symbol = excluded.best_symbol,
      active = true,
      synced_at = now()
  `;

  // Deactivated, never deleted: an alert fired last week still points at these
  // rows, and dropping one would leave that alert unable to name its wallets.
  const [{ count: deactivated }] = await sql`
    with kept as (
      select x.address from jsonb_to_recordset(${sql.json(rows)}) as x(address text)
    )
    update alert_wallets
    set active = false
    where chain = ${CHAIN}
      and active = true
      and address not in (select address from kept)
    returning 1 as count
  `.then((r) => [{ count: r.length }]);

  return deactivated;
}

// --- Helius ---

const HELIUS_BASE = "https://api.helius.xyz/v0/webhooks";

async function heliusRequest(method, path, body) {
  const key = process.env.HELIUS_API_KEY;
  const res = await fetch(`${HELIUS_BASE}${path}${path.includes("?") ? "&" : "?"}api-key=${key}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Helius ${method} ${path} -> ${res.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

/**
 * `ANY`, not `SWAP`.
 *
 * Measured against 120 real transactions from six tracked wallets: Helius typed
 * a DFLOW-routed swap as `UNKNOWN`, and typed three genuine pump.fun sells as
 * `TRANSFER` because an unrelated USDC transfer in the same bundle won its
 * description heuristic. Filtering on `SWAP` would have silently dropped all
 * four. The classifier decides from balance deltas instead, and the cost of
 * `ANY` is roughly 2x the invocations — about half of what arrives is noise it
 * discards in microseconds.
 */
const TRANSACTION_TYPES = ["ANY"];

function webhookUrl() {
  const base =
    process.env.ALERTS_WEBHOOK_URL ||
    process.env.NEXT_PUBLIC_SITE_URL ||
    "https://www.alphawallets.fun";
  return new URL("/api/stream/solana", base).toString();
}

async function syncHelius(addresses) {
  const secret = process.env.HELIUS_WEBHOOK_SECRET;
  if (!secret) throw new Error("HELIUS_WEBHOOK_SECRET is not set — the route would reject every delivery.");

  const target = webhookUrl();
  const existing = await heliusRequest("GET", "");

  // Match on OUR url only. There is another project's webhook on this account
  // (auto-disabled since 2026-07-13); touching it is not ours to do.
  const mine = (existing ?? []).find((w) => w.webhookURL === target);

  const payload = {
    webhookURL: target,
    transactionTypes: TRANSACTION_TYPES,
    accountAddresses: addresses,
    webhookType: "enhanced",
    authHeader: `Bearer ${secret}`,
  };

  if (mine) {
    await heliusRequest("PUT", `/${mine.webhookID}`, payload);
    return { action: "updated", webhookID: mine.webhookID, target };
  }
  const created = await heliusRequest("POST", "", payload);
  return { action: "created", webhookID: created?.webhookID ?? "?", target };
}

// --- Main ---

const all = await eligibleWallets();
const rows = (LIMIT ? all.slice(0, LIMIT) : all).map((r) => ({
  address: r.address,
  wallet_id: r.wallet_id,
  label: r.identity_name,
  twitter: r.twitter,
  token_count: r.token_count,
  avg_multiple_x: r.avg_multiple_x,
  avg_pnl_usd: r.avg_pnl_usd,
  best_multiple_x: r.best_multiple_x,
  best_pnl_usd: r.best_pnl_usd,
  best_symbol: r.best_symbol,
}));

const [current] = await sql`
  select count(*) filter (where active)::int as active, count(*)::int as total
  from alert_wallets where chain = ${CHAIN}
`;

console.log(`eligible:        ${all.length}${LIMIT ? ` (capped to ${rows.length})` : ""}`);
console.log(`already on list: ${current.active} active / ${current.total} total`);
console.log(`named:           ${rows.filter((r) => r.label).length}`);
console.log(`webhook url:     ${webhookUrl()}`);

const sample = rows.slice(0, 5);
console.log("\ntop by best multiple:");
for (const r of sample) {
  const name = r.label ? ` ${r.label}` : "";
  console.log(
    `  ${r.address}${name}  best ${Math.round(r.best_multiple_x)}x  avg ${r.avg_multiple_x.toFixed(1)}x` +
      `  ${r.token_count} wins`
  );
}

if (!APPLY) {
  console.log("\nreport only — pass --apply to write the roster and update Helius.");
  await sql.end();
  process.exit(0);
}

const deactivated = await syncDatabase(rows);
console.log(`\nroster written: ${rows.length} active, ${deactivated} deactivated`);

if (DB_ONLY) {
  console.log("--db-only: Helius untouched.");
} else {
  const result = await syncHelius(rows.map((r) => r.address));
  console.log(`helius ${result.action}: ${result.webhookID}`);
  console.log(`  -> ${result.target}`);
  console.log(`  -> ${rows.length} addresses, types ${TRANSACTION_TYPES.join(",")}`);
}

await sql.end();
