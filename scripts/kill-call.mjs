// Removes a bad call from the record, and blocks the wallets that made it.
//
//   node --env-file=.env.local scripts/kill-call.mjs --symbol GHOUL
//   node --env-file=.env.local scripts/kill-call.mjs --token <mint> --apply
//   node --env-file=.env.local scripts/kill-call.mjs --symbol GHOUL --apply --keep-wallets
//
// Report-only by default. Nothing is written without --apply.
//
// Why both halves are in one script: deleting the call without blocking the
// wallets leaves the wallets free to manufacture the next one, and blocking the
// wallets without deleting the call leaves a fake multiple on the public
// podium. Doing them separately is how one gets forgotten.
//
// The block goes on `wallets.blocked`, NOT just `alert_wallets.active`. The
// roster is rebuilt from `wallet_tokens` on every `alerts:sync --apply`, so a
// wallet only deactivated downstream walks straight back in on the next sync.
//
// After this, run `npm run alerts:sync -- --apply` to push the shortened roster
// to Helius. Until you do, the stream is still paying to watch them.

import postgres from "postgres";

const args = process.argv.slice(2);
const flag = (n) => args.includes(`--${n}`);
const value = (n) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const APPLY = flag("apply");
const KEEP_WALLETS = flag("keep-wallets");
const SYMBOL = value("symbol");
const TOKEN = value("token");
const REASON = value("reason") ?? "manual: bad call";

if (!SYMBOL && !TOKEN) {
  console.error("Pass --symbol <TICKER> or --token <mint>.");
  process.exit(1);
}

const url =
  process.env.POSTGRES_URL_NON_POOLING || process.env.DATABASE_URL || process.env.POSTGRES_URL;
const sql = postgres(url, { prepare: false, max: 1 });

const usd = (n) =>
  n == null
    ? "—"
    : n >= 1e6
      ? `$${(n / 1e6).toFixed(2)}M`
      : n >= 1e3
        ? `$${(n / 1e3).toFixed(1)}K`
        : `$${Math.round(n)}`;

// Match on the token address when given one, otherwise the ticker. Ticker is
// convenient and ambiguous — two different mints can share a symbol — so every
// distinct address it resolves to is printed before anything is deleted.
const calls = TOKEN
  ? await sql`select * from alerts_fired where token_address = ${TOKEN} order by tier`
  : await sql`select * from alerts_fired where token_symbol = ${SYMBOL} order by token_address, tier`;

if (calls.length === 0) {
  console.log("No alert rows match.");
  await sql.end();
  process.exit(0);
}

const addresses = [...new Set(calls.map((c) => c.token_address))];
if (addresses.length > 1) {
  console.error(`\n"${SYMBOL}" resolves to ${addresses.length} different mints:`);
  for (const a of addresses) console.error(`  ${a}`);
  console.error(`\nRe-run with --token <mint> to pick one. Nothing was changed.`);
  await sql.end();
  process.exit(1);
}

console.log(`token   ${addresses[0]}`);
console.log(`alerts  ${calls.length} row${calls.length === 1 ? "" : "s"}`);
for (const c of calls) {
  const x = c.mcap_at_alert_usd && c.ath_mcap_usd
    ? `${(Number(c.ath_mcap_usd) / Number(c.mcap_at_alert_usd)).toFixed(1)}x`
    : "—";
  console.log(
    `  id=${c.id} tier=${String(c.tier).padStart(2)} ep=${c.episode}  ` +
      `${usd(Number(c.mcap_at_alert_usd))} -> ${usd(Number(c.ath_mcap_usd))} (${x})  ` +
      `now ${usd(Number(c.last_mcap_usd))}  ${c.delivered_at ? "delivered" : "not sent"}`
  );
}

// Three separate populations, and missing any of them leaves the rug's
// wallets in place:
//
//  1. the frozen snapshots on the alert rows — what the message claimed;
//  2. every wallet the raw stream saw TRADE it, either side. A seller with no
//     recorded buy is still a holder: the buy simply happened before we were
//     watching, and "traded this" is the question being asked;
//  3. **every wallet with a `wallet_tokens` win on this mint.** This is the one
//     that matters most and the least obvious. If the token was ever scanned,
//     the scan minted a curated "win" per top trader — so a rug with
//     manufactured volume hands out 100x credentials wholesale, and those
//     wallets then qualify for the alert roster on a trade nobody really made.
//     Deleting the call without this leaves the roster full of them.
const named = new Set();
for (const c of calls) for (const w of c.wallets ?? []) named.add(w.address);
for (const r of await sql`
  select distinct wallet_address from wallet_events where token_address = ${addresses[0]}`) {
  named.add(r.wallet_address);
}
for (const r of await sql`
  select distinct w.address from wallet_tokens wt
  join wallets w on w.id = wt.wallet_id
  join tokens t on t.id = wt.token_id
  where lower(t.address) = lower(${addresses[0]})`) {
  named.add(r.address);
}

const buyers = [...named];

// What blocking them actually costs. A wallet that also qualifies on another
// coin has a real credential and blocking it throws away real signal, so the
// split is printed before anything is written rather than discovered after.
const [cost] = await sql`
  with roster as (
    select w.address,
      count(*) filter (where wt.multiple_x >= 5 and coalesce(wt.bought_usd,0) >= 100
                         and lower(t.address) <> lower(${addresses[0]}))::int as elsewhere
    from wallets w
    join wallet_tokens wt on wt.wallet_id = w.id
    join tokens t on t.id = wt.token_id
    join alert_wallets aw on aw.address = w.address and aw.active
    where w.address = any(${buyers}) and w.chain = 'solana'
    group by w.address)
  select count(*)::int total,
    count(*) filter (where elsewhere = 0)::int only_this,
    count(*) filter (where elsewhere > 0)::int also_elsewhere
  from roster`;

console.log(`\ntraders ${buyers.length}  (stream + paid-scan history)`);
console.log(`  active on the alert roster:        ${cost.total}`);
console.log(`  qualified ONLY by this token:      ${cost.only_this}  (fake credentials, free to block)`);
console.log(`  also qualify on another coin:      ${cost.also_elsewhere}  (blocking these costs real signal)`);
console.log();
const DETAIL_LIMIT = 12;
for (const b of buyers.slice(0, DETAIL_LIMIT)) {
  const [row] = await sql`
    select w.address, w.identity_name, w.blocked, aw.active,
      (select count(*)::int from wallet_events e
        where e.wallet_address = w.address and e.side='buy') as buys,
      (select count(distinct e.token_address)::int from wallet_events e
        where e.wallet_address = w.address and e.side='buy') as tokens
    from wallets w left join alert_wallets aw on aw.address = w.address
    where w.address = ${b} and w.chain = 'solana' limit 1`;
  if (!row) {
    console.log(`  ${b}  (not in wallets)`);
    continue;
  }
  console.log(
    `  ${row.address}  ${(row.identity_name ?? "").padEnd(12)}` +
      ` roster=${row.active ? "active" : "no"} blocked=${row.blocked}` +
      `  ${row.buys} buys / ${row.tokens} tokens`
  );
}
if (buyers.length > DETAIL_LIMIT) {
  console.log(`  … and ${buyers.length - DETAIL_LIMIT} more`);
}

if (!APPLY) {
  console.log(`\nreport only — pass --apply to delete the call${KEEP_WALLETS ? "" : " and block the buyers"}.`);
  await sql.end();
  process.exit(0);
}

// The alert rows go. `wallet_events` stays: the raw stream is the evidence of
// how the call was manufactured, and it is the only thing that can be replayed
// to check whether a rule change would have caught it.
const deleted = await sql`
  delete from alerts_fired where token_address = ${addresses[0]} returning id`;
console.log(`\ndeleted ${deleted.length} alert rows`);

// alert_state too, or the token keeps its episode counter and the next buy
// resumes the ladder mid-way instead of starting clean.
await sql`delete from alert_state where token_address = ${addresses[0]}`;

if (!KEEP_WALLETS && buyers.length > 0) {
  const blocked = await sql`
    update wallets set blocked = true, blocked_reason = ${REASON}
    where address = any(${buyers}) and chain = 'solana' returning address`;
  const deactivated = await sql`
    update alert_wallets set active = false
    where address = any(${buyers}) returning address`;
  // The fake wins themselves. Leaving them would keep showing a 117x on a
  // rugged token to anyone who scans it, and the block flag alone does not
  // clean the curated archive — it only stops the roster re-adding them.
  const wiped = await sql`
    delete from wallet_tokens wt
    using tokens t
    where t.id = wt.token_id and lower(t.address) = lower(${addresses[0]})
    returning wt.wallet_id`;
  console.log(`blocked ${blocked.length} wallets, deactivated ${deactivated.length} roster rows`);
  console.log(`deleted ${wiped.length} fake wallet_tokens wins on this mint`);
  console.log(`\nNow run:  npm run alerts:sync -- --apply    (drops them from Helius)`);
}

await sql.end();
