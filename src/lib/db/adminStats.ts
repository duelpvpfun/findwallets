import "server-only";
import { sql } from "drizzle-orm";
import { getDb } from "./index";

// Row shapes are `type` aliases, not interfaces: drizzle's `execute<TRow>`
// constrains to Record<string, unknown>, which an interface doesn't satisfy.
export type RevenueTotals = {
  payments: number;
  revenueUsd: number;
  payments24h: number;
  revenue24h: number;
  payments7d: number;
  revenue7d: number;
};

export type PaymentRow = {
  paymentId: string;
  method: string | null;
  tier: number;
  amountUsd: number;
  payerWallet: string | null;
  /** True when this is the earliest payment on record for that payer wallet,
   * i.e. the buyer's first purchase. Always false when the payer is unknown. */
  isNewCustomer: boolean;
  createdAt: string;
  consumedAt: string | null;
  consumedChain: string | null;
  consumedTokenAddress: string | null;
  consumedTokenSymbol: string | null;
};

export type VisitorTotals = {
  views24h: number;
  visitors24h: number;
  views7d: number;
  visitors7d: number;
  /** 30-day window. An unfiltered count(*) over site_visits was a full scan on
   * every dashboard load and got slower every day the site stayed up. */
  views30d: number;
  visitors30d: number;
};

/** One point of the traffic/revenue chart. `bucket` is a day or an hour label
 * depending on which series it came from. */
export type TimePoint = {
  bucket: string;
  views: number;
  visitors: number;
  payments: number;
  revenueUsd: number;
};

export type UsageRow = {
  provider: string;
  endpoint: string;
  calls: number;
  credits: number;
  errors: number;
};

export type FunnelRow = {
  intents: number;
  intentsPaid: number;
  intentsOpen: number;
};

export type NameCount = { name: string; views: number };

/** Planner row estimates from pg_class, not exact counts: wallet_tokens is
 * headed for millions of rows and an exact count is a sequential scan. */
export type ContentTotals = {
  tokens: number;
  wallets: number;
  walletTokens: number;
  cachedDetails: number;
};

export interface AdminStats {
  revenue: RevenueTotals;
  payments: PaymentRow[];
  visitors: VisitorTotals;
  daily: TimePoint[];
  hourly: TimePoint[];
  usageToday: UsageRow[];
  usage7d: UsageRow[];
  funnel: FunnelRow;
  topReferrers: NameCount[];
  topCountries: NameCount[];
  content: ContentTotals;
  treasury: string | null;
  generatedAt: string;
}

/** Tier price list, mirrored from src/lib/tiers.ts so revenue can be summed in
 * SQL. Retired 50-wallet credits keep their old $1.99 price. */
const TIER_PRICE = sql`
  case tier
    when 50 then 1.99
    when 100 then 2.99
    when 250 then 4.45
    when 500 then 5.99
    else 0
  end`;

export async function fetchAdminStats(): Promise<AdminStats | null> {
  const db = getDb();
  if (!db) return null;

  // Strictly one query at a time. postgres.js pipelines concurrent queries onto
  // its pooled connections, and once a fan-out outruns the pool, Supabase's
  // transaction pooler stops answering altogether: the queries never return, the
  // request hangs until the platform kills it, and the dashboard is simply
  // unreachable. Measured against the live database, an 11-way Promise.all on a
  // pool of one hung indefinitely, while the same queries run one after another
  // in ~150ms total. There is nothing to win by firing them together.
  const revenue = await db.execute<RevenueTotals>(sql`
    select
      count(*)::int as "payments",
      coalesce(sum(${TIER_PRICE}), 0)::float8 as "revenueUsd",
      count(*) filter (where created_at > now() - interval '24 hours')::int as "payments24h",
      coalesce(sum(${TIER_PRICE}) filter (where created_at > now() - interval '24 hours'), 0)::float8 as "revenue24h",
      count(*) filter (where created_at > now() - interval '7 days')::int as "payments7d",
      coalesce(sum(${TIER_PRICE}) filter (where created_at > now() - interval '7 days'), 0)::float8 as "revenue7d"
    from scan_credits`);

  // Case-insensitive address join: EVM addresses are stored checksummed in
  // `tokens` but arrive lowercased on the credit, so `=` misses them.
  const payments = await db.execute<PaymentRow>(sql`
    select
      c.payment_id as "paymentId",
      c.method,
      c.tier,
      (case c.tier
        when 50 then 1.99 when 100 then 2.99
        when 250 then 4.45 when 500 then 5.99 else 0 end)::float8 as "amountUsd",
      c.payer_wallet as "payerWallet",
      -- First-purchase flag. The window runs over the whole table before the
      -- limit, so it stays correct even once a wallet's earlier payments have
      -- scrolled off this page. Exact-match partition, no lower(): payers are
      -- Solana base58 addresses and that is how users.ts matches them too.
      (c.payer_wallet is not null
        and c.created_at = min(c.created_at) over (partition by c.payer_wallet)) as "isNewCustomer",
      c.created_at as "createdAt",
      c.consumed_at as "consumedAt",
      c.consumed_chain as "consumedChain",
      c.consumed_token_address as "consumedTokenAddress",
      t.symbol as "consumedTokenSymbol"
    from scan_credits c
    left join tokens t
      on t.chain = c.consumed_chain
     and lower(t.address) = lower(c.consumed_token_address)
    order by c.created_at desc
    limit 100`);

  const visitors = await db.execute<VisitorTotals>(sql`
    select
      count(*) filter (where created_at > now() - interval '24 hours')::int as "views24h",
      count(distinct visitor_hash) filter (where created_at > now() - interval '24 hours')::int as "visitors24h",
      count(*) filter (where created_at > now() - interval '7 days')::int as "views7d",
      count(distinct visitor_hash) filter (where created_at > now() - interval '7 days')::int as "visitors7d",
      count(*)::int as "views30d",
      count(distinct visitor_hash)::int as "visitors30d"
    from site_visits
    where created_at > now() - interval '30 days'`);

  const funnel = await db.execute<FunnelRow>(sql`
    select
      count(*)::int as intents,
      count(*) filter (where status = 'consumed')::int as "intentsPaid",
      count(*) filter (where status <> 'consumed')::int as "intentsOpen"
    from payment_intents
    where created_at > now() - interval '30 days'`);

  // generate_series supplies the full 30-day axis, so quiet days render as
  // zeroes instead of silently compressing the chart.
  const daily = await db.execute<TimePoint>(sql`
    with days as (
      select generate_series(
        (now() - interval '29 days')::date, now()::date, interval '1 day'
      )::date as day
    ),
    v as (
      select created_at::date as day,
             count(*)::int as views,
             count(distinct visitor_hash)::int as visitors
      from site_visits
      where created_at > now() - interval '30 days'
      group by 1
    ),
    p as (
      select created_at::date as day,
             count(*)::int as payments,
             coalesce(sum(${TIER_PRICE}), 0)::float8 as revenue
      from scan_credits
      where created_at > now() - interval '30 days'
      group by 1
    )
    select
      to_char(days.day, 'YYYY-MM-DD') as bucket,
      coalesce(v.views, 0)::int as views,
      coalesce(v.visitors, 0)::int as visitors,
      coalesce(p.payments, 0)::int as payments,
      coalesce(p.revenue, 0)::float8 as "revenueUsd"
    from days
    left join v on v.day = days.day
    left join p on p.day = days.day
    order by days.day`);

  // Same shape at hourly resolution over 48h. Buckets are UTC; the client
  // relabels them in local time so the axis matches the payment timestamps.
  const hourly = await db.execute<TimePoint>(sql`
    with hours as (
      select generate_series(
        date_trunc('hour', now() - interval '47 hours'),
        date_trunc('hour', now()),
        interval '1 hour'
      ) as hour
    ),
    v as (
      select date_trunc('hour', created_at) as hour,
             count(*)::int as views,
             count(distinct visitor_hash)::int as visitors
      from site_visits
      where created_at > now() - interval '48 hours'
      group by 1
    ),
    p as (
      select date_trunc('hour', created_at) as hour,
             count(*)::int as payments,
             coalesce(sum(${TIER_PRICE}), 0)::float8 as revenue
      from scan_credits
      where created_at > now() - interval '48 hours'
      group by 1
    )
    select
      to_char(hours.hour at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as bucket,
      coalesce(v.views, 0)::int as views,
      coalesce(v.visitors, 0)::int as visitors,
      coalesce(p.payments, 0)::int as payments,
      coalesce(p.revenue, 0)::float8 as "revenueUsd"
    from hours
    left join v on v.hour = hours.hour
    left join p on p.hour = hours.hour
    order by hours.hour`);

  const usageToday = await db.execute<UsageRow>(sql`
    select provider, endpoint,
           sum(calls)::int as calls,
           sum(credits)::float8 as credits,
           sum(errors)::int as errors
    from api_usage
    where day = current_date
    group by 1, 2
    order by credits desc`);

  const usage7d = await db.execute<UsageRow>(sql`
    select provider, endpoint,
           sum(calls)::int as calls,
           sum(credits)::float8 as credits,
           sum(errors)::int as errors
    from api_usage
    where day > current_date - 7
    group by 1, 2
    order by credits desc`);

  const referrers = await db.execute<NameCount>(sql`
    select coalesce(referrer, 'direct') as name, count(*)::int as views
    from site_visits
    where created_at > now() - interval '30 days'
    group by 1 order by views desc limit 10`);

  const countries = await db.execute<NameCount>(sql`
    select coalesce(country, '--') as name, count(*)::int as views
    from site_visits
    where created_at > now() - interval '30 days'
    group by 1 order by views desc limit 10`);

  // reltuples is the planner's estimate, maintained by autovacuum. Approximate
  // by design — an exact count here means four sequential scans, one of them
  // over the largest table in the schema. It reads -1 on a table autovacuum has
  // never visited, which would otherwise render as "-1 cached details".
  const content = await db.execute<ContentTotals>(sql`
    select
      greatest(coalesce(max(reltuples) filter (where relname = 'tokens'), 0), 0)::int as tokens,
      greatest(coalesce(max(reltuples) filter (where relname = 'wallets'), 0), 0)::int as wallets,
      greatest(coalesce(max(reltuples) filter (where relname = 'wallet_tokens'), 0), 0)::int as "walletTokens",
      greatest(coalesce(max(reltuples) filter (where relname = 'wallet_detail_cache'), 0), 0)::int as "cachedDetails"
    from pg_class
    where relname in ('tokens', 'wallets', 'wallet_tokens', 'wallet_detail_cache')
      and relkind = 'r'`);

  return {
    revenue: revenue[0],
    payments: [...payments],
    visitors: visitors[0],
    daily: [...daily],
    hourly: [...hourly],
    usageToday: [...usageToday],
    usage7d: [...usage7d],
    funnel: funnel[0],
    topReferrers: [...referrers],
    topCountries: [...countries],
    content: content[0],
    treasury: process.env.SOLANA_TREASURY_WALLET ?? null,
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Recomputes the snapshot the dashboard reads. Called from a cron, so the
 * dashboard itself never pays for the aggregates no matter how many tabs poll.
 */
export async function refreshAdminStatsSnapshot(): Promise<boolean> {
  const db = getDb();
  if (!db) return false;

  const stats = await fetchAdminStats();
  if (!stats) return false;

  await db.execute(sql`
    insert into stats_snapshot (id, payload, generated_at)
    values (1, ${JSON.stringify(stats)}::jsonb, now())
    on conflict (id) do update
      set payload = excluded.payload, generated_at = excluded.generated_at`);
  return true;
}

export type StatsSnapshot = { stats: AdminStats; generatedAt: string };

/** One indexed single-row read, regardless of how much data the site has. */
export async function readAdminStatsSnapshot(): Promise<StatsSnapshot | null> {
  const db = getDb();
  if (!db) return null;

  const rows = await db.execute<{ payload: AdminStats; generatedAt: string }>(sql`
    select payload, generated_at as "generatedAt" from stats_snapshot where id = 1`);
  const row = rows[0];
  if (!row) return null;
  return { stats: row.payload, generatedAt: row.generatedAt };
}
