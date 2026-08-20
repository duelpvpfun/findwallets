// One-shot health report: size, growth, bloat, index usage, data sanity.
import postgres from "postgres";

const url = process.env.POSTGRES_URL_NON_POOLING || process.env.POSTGRES_URL;
const sql = postgres(url, { prepare: false, max: 1 });
const host = new URL(url).host;

const p = (label, v) => console.log(String(label).padEnd(34), v);
const mb = (b) => `${(Number(b) / 1024 / 1024).toFixed(1)} MB`;

console.log(`host: ${host}\n`);

const [ver] = await sql`select version() as v`;
p("server", ver.v.split(" ").slice(0, 2).join(" "));

const [dbs] = await sql`select pg_database_size(current_database()) as b`;
p("total database size", mb(dbs.b));

console.log("\n--- table sizes / rows ---");
const tables = await sql`
  select c.relname as name,
         c.reltuples::bigint as est_rows,
         pg_total_relation_size(c.oid) as total,
         pg_relation_size(c.oid) as heap,
         pg_indexes_size(c.oid) as idx
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind = 'r'
  order by pg_total_relation_size(c.oid) desc
`;
for (const t of tables) {
  const [{ c }] = await sql.unsafe(`select count(*)::bigint as c from "${t.name}"`);
  console.log(
    `${t.name.padEnd(22)} rows=${String(c).padStart(8)}  total=${mb(t.total).padStart(9)}  heap=${mb(t.heap).padStart(9)}  idx=${mb(t.idx).padStart(9)}`
  );
}

console.log("\n--- dead tuples / vacuum ---");
const bloat = await sql`
  select relname, n_live_tup, n_dead_tup,
         coalesce(to_char(last_autovacuum,'MM-DD HH24:MI'),'never') as autovac,
         coalesce(to_char(last_autoanalyze,'MM-DD HH24:MI'),'never') as autoanalyze
  from pg_stat_user_tables
  where n_dead_tup > 0
  order by n_dead_tup desc limit 10
`;
if (!bloat.length) console.log("(no dead tuples)");
for (const b of bloat)
  console.log(
    `${b.relname.padEnd(22)} live=${String(b.n_live_tup).padStart(7)} dead=${String(b.n_dead_tup).padStart(7)} vac=${b.autovac} ana=${b.autoanalyze}`
  );

console.log("\n--- unused indexes (idx_scan = 0) ---");
const unused = await sql`
  select relname, indexrelname, idx_scan, pg_relation_size(indexrelid) as sz
  from pg_stat_user_indexes
  where idx_scan = 0
  order by pg_relation_size(indexrelid) desc
`;
if (!unused.length) console.log("(all indexes used)");
for (const u of unused) console.log(`${u.relname.padEnd(22)} ${u.indexrelname.padEnd(40)} ${mb(u.sz)}`);

console.log("\n--- connections ---");
const conns = await sql`
  select state, count(*)::int as c from pg_stat_activity
  where datname = current_database() group by state order by c desc
`;
for (const c of conns) p(c.state ?? "null", c.c);
const [{ mc }] = await sql`select setting::int as mc from pg_settings where name='max_connections'`;
p("max_connections", mc);

console.log("\n--- cache hit ratio ---");
const [hit] = await sql`
  select round(100.0*sum(heap_blks_hit)/nullif(sum(heap_blks_hit+heap_blks_read),0), 2) as pct
  from pg_statio_user_tables
`;
p("heap cache hit %", hit.pct);

console.log("\n=== DATA SANITY ===");

const q = async (label, query) => {
  const [r] = await query;
  p(label, Object.values(r)[0]);
};

await q("wallets total", sql`select count(*)::int from wallets`);
await q("wallets enriched", sql`select count(*)::int from wallets where enriched_at is not null`);
await q("wallets w/ lifetime pnl", sql`select count(*)::int from wallets where lifetime_pnl_usd is not null`);
await q("wallets flagged bot", sql`select count(*)::int from wallets where is_bot`);
await q("wallets w/ win_badges", sql`select count(*)::int from wallets where cardinality(win_badges) > 0`);
await q("wallets seen >1 scan", sql`select count(*)::int from wallets where times_seen > 1`);

console.log("\nwallets per chain:");
const perChain = await sql`
  select chain, count(*)::int as c,
         count(*) filter (where enriched_at is not null)::int as enriched,
         count(*) filter (where lifetime_pnl_usd is not null)::int as lifetime
  from wallets group by chain order by c desc
`;
for (const r of perChain) console.log(`  ${r.chain.padEnd(10)} ${String(r.c).padStart(6)}  enriched=${r.enriched}  lifetime=${r.lifetime}`);

console.log("\ntokens per chain:");
const tokChain = await sql`select chain, count(*)::int as c, sum(scan_count)::int as scans from tokens group by chain order by c desc`;
for (const r of tokChain) console.log(`  ${r.chain.padEnd(10)} ${String(r.c).padStart(6)}  scans=${r.scans}`);

console.log("\n--- suspicious rows ---");
await q("wallet_tokens total", sql`select count(*)::int from wallet_tokens`);
await q("  multiple_x null", sql`select count(*)::int from wallet_tokens where multiple_x is null`);
await q("  multiple_x > 500", sql`select count(*)::int from wallet_tokens where multiple_x > 500`);
await q("  realized_pnl > $100M", sql`select count(*)::int from wallet_tokens where realized_pnl_usd > 100000000`);
await q("  realized_pnl <= 0", sql`select count(*)::int from wallet_tokens where realized_pnl_usd <= 0`);
await q("  bought_usd null", sql`select count(*)::int from wallet_tokens where bought_usd is null`);
await q("  bought_usd < $100", sql`select count(*)::int from wallet_tokens where bought_usd < 100`);
await q("  remaining_pct null", sql`select count(*)::int from wallet_tokens where remaining_percent is null`);
await q("  remaining_pct >100", sql`select count(*)::int from wallet_tokens where remaining_percent > 100`);
await q("  last_trade_ms null", sql`select count(*)::int from wallet_tokens where last_trade_ms is null`);

await q("wallet_positions total", sql`select count(*)::int from wallet_positions`);
await q("  multiple_x > 500", sql`select count(*)::int from wallet_positions where multiple_x > 500`);
await q("  total_pnl > $100M", sql`select count(*)::int from wallet_positions where total_pnl_usd > 100000000`);
await q("  stale >30d", sql`select count(*)::int from wallet_positions where fetched_at < now() - interval '30 days'`);

console.log("\n--- orphans / integrity ---");
await q("wallet_tokens orphan wallet", sql`select count(*)::int from wallet_tokens wt left join wallets w on w.id=wt.wallet_id where w.id is null`);
await q("wallet_tokens orphan token", sql`select count(*)::int from wallet_tokens wt left join tokens t on t.id=wt.token_id where t.id is null`);
await q("wallets w/ no wallet_tokens", sql`select count(*)::int from wallets w left join wallet_tokens wt on wt.wallet_id=w.id where wt.wallet_id is null`);
await q("tokens w/ no wallet_tokens", sql`select count(*)::int from tokens t left join wallet_tokens wt on wt.token_id=t.id where wt.token_id is null`);
await q("dup wallets (chain,addr)", sql`select count(*)::int from (select chain,address from wallets group by 1,2 having count(*)>1) x`);
await q("tokens missing symbol", sql`select count(*)::int from tokens where symbol is null or symbol=''`);
await q("tokens missing mcap", sql`select count(*)::int from tokens where market_cap_usd is null`);

console.log("\n--- money ---");
const credits = await sql`
  select tier, count(*)::int as n,
         count(*) filter (where consumed_at is not null)::int as consumed,
         count(*) filter (where claimed_at is not null)::int as claimed
  from scan_credits group by tier order by tier
`;
if (!credits.length) console.log("(no scan_credits)");
for (const c of credits) console.log(`  tier ${String(c.tier).padStart(3)}  paid=${c.n} claimed=${c.claimed} consumed=${c.consumed}`);
await q("payment_intents pending", sql`select count(*)::int from payment_intents where status='pending'`);
await q("payment_intents expired-pending", sql`select count(*)::int from payment_intents where status='pending' and expires_at < now()`);

console.log("\n--- growth / churn tables ---");
const growth = await sql`
  select 'site_visits' as t, count(*)::int as total,
    count(*) filter (where created_at > now() - interval '24 hours')::int as d1,
    count(*) filter (where created_at > now() - interval '7 days')::int as d7,
    coalesce(to_char(min(created_at),'YYYY-MM-DD'),'-') as oldest
  from site_visits
  union all
  select 'webhook_log', count(*)::int,
    count(*) filter (where created_at > now() - interval '24 hours')::int,
    count(*) filter (where created_at > now() - interval '7 days')::int,
    coalesce(to_char(min(created_at),'YYYY-MM-DD'),'-')
  from webhook_log
  union all
  select 'wallet_detail_cache', count(*)::int,
    count(*) filter (where fetched_at > now() - interval '24 hours')::int,
    count(*) filter (where fetched_at > now() - interval '7 days')::int,
    coalesce(to_char(min(fetched_at),'YYYY-MM-DD'),'-')
  from wallet_detail_cache
`;
for (const g of growth) console.log(`  ${g.t.padEnd(20)} total=${String(g.total).padStart(7)} 24h=${String(g.d1).padStart(6)} 7d=${String(g.d7).padStart(6)} since=${g.oldest}`);

const [detailBytes] = await sql`select coalesce(sum(length(payload)),0)::bigint as b, coalesce(max(length(payload)),0)::int as mx from wallet_detail_cache`;
p("detail cache payload bytes", `${mb(detailBytes.b)} (max row ${(detailBytes.mx / 1024).toFixed(1)} KB)`);

console.log("\n--- api usage (last 7d) ---");
const usage = await sql`
  select provider, sum(calls)::int as calls, sum(credits)::float as credits, sum(errors)::int as errors
  from api_usage where day > current_date - 7 group by provider order by calls desc
`;
if (!usage.length) console.log("(none)");
for (const u of usage) console.log(`  ${u.provider.padEnd(16)} calls=${u.calls} credits=${Math.round(u.credits)} errors=${u.errors}`);

console.log("\n--- freshness ---");
const fresh = await sql`
  select
    (select to_char(max(last_scanned_at),'YYYY-MM-DD HH24:MI') from tokens) as last_scan,
    (select to_char(max(last_seen_at),'YYYY-MM-DD HH24:MI') from wallets) as last_wallet,
    (select to_char(max(enriched_at),'YYYY-MM-DD HH24:MI') from wallets) as last_enrich,
    (select to_char(max(created_at),'YYYY-MM-DD HH24:MI') from site_visits) as last_visit
`;
for (const [k, v] of Object.entries(fresh[0])) p(k, v ?? "never");

await sql.end();
