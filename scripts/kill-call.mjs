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

// Everyone named in the frozen snapshots, plus anyone the raw stream saw buy
// it. The snapshot is what the message claimed; the stream is the truth, and a
// wallet can be in one without the other.
const named = new Set();
for (const c of calls) for (const w of c.wallets ?? []) named.add(w.address);
const streamed = await sql`
  select distinct wallet_address from wallet_events
  where token_address = ${addresses[0]} and side = 'buy'`;
for (const r of streamed) named.add(r.wallet_address);

const buyers = [...named];
console.log(`\nbuyers  ${buyers.length}`);
for (const b of buyers) {
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
  console.log(`blocked ${blocked.length} wallets, deactivated ${deactivated.length} roster rows`);
  console.log(`\nNow run:  npm run alerts:sync -- --apply    (drops them from Helius)`);
}

await sql.end();
