import postgres from "postgres";
// Mirror the app's real pool config from src/lib/db/index.ts
const sql = postgres(process.env.POSTGRES_URL, { prepare: false, max: 5 });
const T = sql`case tier when 50 then 1.99 when 100 then 2.99 when 250 then 4.45 when 500 then 5.99 else 0 end`;

function allQueries() {
  return [
    sql`select count(*)::int a, coalesce(sum(${T}),0)::float8 b from scan_credits`,
    sql`select c.payment_id, t.symbol from scan_credits c left join tokens t on t.chain=c.consumed_chain and lower(t.address)=lower(c.consumed_token_address) order by c.created_at desc limit 100`,
    sql`select count(distinct visitor_hash)::int b from site_visits`,
    sql`with d as (select generate_series((now()-interval '29 days')::date,now()::date,interval '1 day')::date x) select x from d`,
    sql`with h as (select generate_series(date_trunc('hour',now()-interval '47 hours'),date_trunc('hour',now()),interval '1 hour') x) select x from h`,
    sql`select provider,endpoint,sum(calls)::int c from api_usage where day=current_date group by 1,2`,
    sql`select provider,endpoint,sum(calls)::int c from api_usage where day>current_date-7 group by 1,2`,
    sql`select count(*)::int a from payment_intents`,
    sql`select coalesce(referrer,'direct') n,count(*)::int v from site_visits group by 1 order by v desc limit 10`,
    sql`select coalesce(country,'--') n,count(*)::int v from site_visits group by 1 order by v desc limit 10`,
    sql`select (select count(*) from tokens)::int a,(select count(*) from wallets)::int b,(select count(*) from wallet_tokens)::int c,(select count(*) from wallet_detail_cache)::int d`,
  ];
}

console.log("11 parallel queries on max:5 pool, 10 consecutive rounds (simulates 10 min of polling):");
for (let i = 1; i <= 10; i++) {
  const t = Date.now();
  await Promise.all(allQueries());
  console.log(`  round ${String(i).padStart(2)}: ${Date.now() - t}ms`);
}
await sql.end();
