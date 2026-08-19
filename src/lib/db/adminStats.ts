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
  createdAt: string;
  consumedAt: string | null;
  consumedChain: string | null;
  consumedTokenAddress: string | null;
};

export type VisitorTotals = {
  views24h: number;
  visitors24h: number;
  views7d: number;
  visitors7d: number;
  viewsAll: number;
  visitorsAll: number;
};

export type DailyPoint = {
  day: string;
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
  daily: DailyPoint[];
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

  const [
    revenue,
    payments,
    visitors,
    daily,
    usageToday,
    usage7d,
    funnel,
    referrers,
    countries,
    content,
  ] = await Promise.all([
    db.execute<RevenueTotals>(sql`
      select
        count(*)::int as "payments",
        coalesce(sum(${TIER_PRICE}), 0)::float8 as "revenueUsd",
        count(*) filter (where created_at > now() - interval '24 hours')::int as "payments24h",
        coalesce(sum(${TIER_PRICE}) filter (where created_at > now() - interval '24 hours'), 0)::float8 as "revenue24h",
        count(*) filter (where created_at > now() - interval '7 days')::int as "payments7d",
        coalesce(sum(${TIER_PRICE}) filter (where created_at > now() - interval '7 days'), 0)::float8 as "revenue7d"
      from scan_credits`),

    db.execute<PaymentRow>(sql`
      select
        payment_id as "paymentId",
        method,
        tier,
        (${TIER_PRICE})::float8 as "amountUsd",
        payer_wallet as "payerWallet",
        created_at as "createdAt",
        consumed_at as "consumedAt",
        consumed_chain as "consumedChain",
        consumed_token_address as "consumedTokenAddress"
      from scan_credits
      order by created_at desc
      limit 100`),

    db.execute<VisitorTotals>(sql`
      select
        count(*) filter (where created_at > now() - interval '24 hours')::int as "views24h",
        count(distinct visitor_hash) filter (where created_at > now() - interval '24 hours')::int as "visitors24h",
        count(*) filter (where created_at > now() - interval '7 days')::int as "views7d",
        count(distinct visitor_hash) filter (where created_at > now() - interval '7 days')::int as "visitors7d",
        count(*)::int as "viewsAll",
        count(distinct visitor_hash)::int as "visitorsAll"
      from site_visits`),

    // generate_series supplies the full 30-day axis, so quiet days render as
    // zeroes instead of silently compressing the chart.
    db.execute<DailyPoint>(sql`
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
        to_char(days.day, 'YYYY-MM-DD') as day,
        coalesce(v.views, 0)::int as views,
        coalesce(v.visitors, 0)::int as visitors,
        coalesce(p.payments, 0)::int as payments,
        coalesce(p.revenue, 0)::float8 as "revenueUsd"
      from days
      left join v on v.day = days.day
      left join p on p.day = days.day
      order by days.day`),

    db.execute<UsageRow>(sql`
      select provider, endpoint,
             sum(calls)::int as calls,
             sum(credits)::float8 as credits,
             sum(errors)::int as errors
      from api_usage
      where day = current_date
      group by 1, 2
      order by credits desc`),

    db.execute<UsageRow>(sql`
      select provider, endpoint,
             sum(calls)::int as calls,
             sum(credits)::float8 as credits,
             sum(errors)::int as errors
      from api_usage
      where day > current_date - 7
      group by 1, 2
      order by credits desc`),

    db.execute<FunnelRow>(sql`
      select
        count(*)::int as intents,
        count(*) filter (where status = 'consumed')::int as "intentsPaid",
        count(*) filter (where status <> 'consumed')::int as "intentsOpen"
      from payment_intents`),

    db.execute<NameCount>(sql`
      select coalesce(referrer, 'direct') as name, count(*)::int as views
      from site_visits
      where created_at > now() - interval '30 days'
      group by 1 order by views desc limit 10`),

    db.execute<NameCount>(sql`
      select coalesce(country, '--') as name, count(*)::int as views
      from site_visits
      where created_at > now() - interval '30 days'
      group by 1 order by views desc limit 10`),

    db.execute<ContentTotals>(sql`
      select
        (select count(*) from tokens)::int as tokens,
        (select count(*) from wallets)::int as wallets,
        (select count(*) from wallet_tokens)::int as "walletTokens",
        (select count(*) from wallet_detail_cache)::int as "cachedDetails"`),
  ]);

  return {
    revenue: revenue[0],
    payments: [...payments],
    visitors: visitors[0],
    daily: [...daily],
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
