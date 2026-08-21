// How the alert stream is doing, from the terminal.
//
//   node --env-file=.env.local scripts/alerts-stats.mjs
//   node --env-file=.env.local scripts/alerts-stats.mjs --days 7
//
// The same figures the /alerts page shows, plus the operational ones it does
// not: stream liveness, event volume, delivery failures. Read this before
// concluding the product is quiet — a dead Helius webhook and a genuinely slow
// day look identical from the feed.
import postgres from "postgres";

const args = process.argv.slice(2);
const daysArg = args.indexOf("--days");
const DAYS = daysArg >= 0 ? Number(args[daysArg + 1]) || 30 : 30;
const CHAIN = "solana";

/** Matches MIN_SCOREBOARD_MCAP_USD in src/lib/alerts/config.ts. */
const MIN_SCOREBOARD_MCAP_USD = 20_000;

const url = process.env.POSTGRES_URL_NON_POOLING || process.env.POSTGRES_URL;
const sql = postgres(url, { prepare: false, max: 2 });

const fmt = (n, digits = 2) =>
  n === null || n === undefined ? "—" : Number(n).toFixed(digits);
const usd = (n) => {
  if (n === null || n === undefined) return "—";
  const v = Number(n);
  if (Math.abs(v) >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
  if (Math.abs(v) >= 1e6) return `$${(v / 1e6).toFixed(2)}M`;
  if (Math.abs(v) >= 1e3) return `$${(v / 1e3).toFixed(1)}K`;
  return `$${v.toFixed(0)}`;
};

const [roster] = await sql`
  select count(*) filter (where active)::int as active,
         count(*)::int as total,
         count(*) filter (where active and label is not null)::int as named
  from alert_wallets where chain = ${CHAIN}
`;

const [stream] = await sql`
  select
    count(*)::int as events,
    count(*) filter (where side = 'buy')::int as buys,
    count(*) filter (where side = 'sell')::int as sells,
    count(distinct token_address)::int as tokens,
    count(distinct wallet_address)::int as wallets,
    extract(epoch from (now() - max(created_at)))::int as silent_for
  from wallet_events
  where chain = ${CHAIN} and block_time > now() - interval '24 hours'
`;

const tiers = await sql`
  with scored as (
    select
      tier,
      case when mcap_at_alert_usd >= ${MIN_SCOREBOARD_MCAP_USD} and ath_mcap_usd is not null
           then ath_mcap_usd / mcap_at_alert_usd end as peak_x,
      case when mcap_at_alert_usd >= ${MIN_SCOREBOARD_MCAP_USD} and last_mcap_usd is not null
           then last_mcap_usd / mcap_at_alert_usd end as now_x
    from alerts_fired
    where chain = ${CHAIN} and superseded = false
      and created_at > now() - make_interval(days => ${DAYS})
  )
  select tier,
         count(*)::int as alerts,
         count(peak_x)::int as scored,
         avg(peak_x)::float8 as avg_peak,
         percentile_cont(0.5) within group (order by peak_x)::float8 as median_peak,
         max(peak_x)::float8 as best_peak,
         (count(*) filter (where peak_x >= 2)::float8 / nullif(count(peak_x), 0)) as hit_2x
  from scored group by tier order by tier
`;

const [delivery] = await sql`
  select
    count(*)::int as total,
    count(*) filter (where delivered_at is not null)::int as delivered,
    count(*) filter (where delivery_error is not null)::int as failed
  from alerts_fired
  where chain = ${CHAIN} and superseded = false
    and created_at > now() - make_interval(days => ${DAYS})
`;

const best = await sql`
  select token_symbol, token_address, tier, mcap_at_alert_usd, ath_mcap_usd, created_at
  from alerts_fired
  where chain = ${CHAIN} and superseded = false
    and mcap_at_alert_usd >= ${MIN_SCOREBOARD_MCAP_USD} and ath_mcap_usd is not null
  order by ath_mcap_usd / mcap_at_alert_usd desc
  limit 5
`;

console.log(`\nROSTER`);
console.log(`  ${roster.active} active / ${roster.total} total  ·  ${roster.named} with a name`);

console.log(`\nSTREAM (24h)`);
if (stream.events === 0) {
  console.log(`  no events — the webhook may be disabled, or nothing qualified`);
} else {
  console.log(
    `  ${stream.events} events (${stream.buys} buys, ${stream.sells} sells)` +
      `  ·  ${stream.wallets} wallets  ·  ${stream.tokens} tokens`
  );
}
// Helius auto-disables a receiver that keeps failing and says nothing. Long
// silence is the only symptom, so it gets called out rather than left to read.
const silent = stream.silent_for;
if (silent === null) console.log(`  last event: never`);
else if (silent > 5400) console.log(`  last event: ${Math.round(silent / 60)}m ago  ** CHECK THE WEBHOOK **`);
else console.log(`  last event: ${Math.round(silent / 60)}m ago`);

console.log(`\nTIER PERFORMANCE (${DAYS}d)`);
if (tiers.length === 0) {
  console.log(`  no alerts yet`);
} else {
  console.log(`  tier   alerts  scored   avg     median  best     hit2x`);
  for (const t of tiers) {
    console.log(
      `  ${String(t.tier).padStart(4)}   ${String(t.alerts).padStart(6)}  ` +
        `${String(t.scored).padStart(6)}   ${fmt(t.avg_peak).padStart(6)}x ` +
        `${fmt(t.median_peak).padStart(6)}x ${fmt(t.best_peak).padStart(7)}x  ` +
        `${t.hit_2x === null ? "—" : `${Math.round(t.hit_2x * 100)}%`}`
    );
  }
}

console.log(`\nDELIVERY (${DAYS}d)`);
console.log(
  `  ${delivery.delivered}/${delivery.total} delivered` +
    (delivery.failed > 0 ? `  ·  ${delivery.failed} FAILED` : "")
);

if (best.length > 0) {
  console.log(`\nBEST CALLS`);
  for (const b of best) {
    const x = b.ath_mcap_usd / b.mcap_at_alert_usd;
    console.log(
      // Some upstream symbols already carry a leading $; adding ours gave "$$WIF".
      `  ${fmt(x, 1).padStart(6)}x  $${(b.token_symbol ?? "?").replace(/^\$+/, "").padEnd(10)} tier ${b.tier}  ` +
        `${usd(b.mcap_at_alert_usd)} -> ${usd(b.ath_mcap_usd)}  ${b.created_at.toISOString().slice(0, 10)}`
    );
  }
}

console.log();
await sql.end();
