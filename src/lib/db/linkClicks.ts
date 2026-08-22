import "server-only";
import { sql } from "drizzle-orm";
import { getDb } from "./index";
import { linkClicks, tokens } from "./schema";
import { visitorHash } from "./visits";

/**
 * Reads and writes for the buy-link ledger.
 *
 * The write is best-effort by contract: a click that fails to record is a lost
 * data point, and a reader who is not sent to the venue is a lost buyer. The
 * redirect never waits on this — `/api/go` schedules it with `after()`.
 */

export interface LinkClickInput {
  source: string;
  venue: string;
  chain: string;
  tokenAddress: string;
  ip: string;
  userAgent: string;
  country: string | null;
}

export async function recordLinkClick(input: LinkClickInput): Promise<void> {
  const db = getDb();
  if (!db) return;
  try {
    await db.insert(linkClicks).values({
      source: input.source,
      venue: input.venue,
      chain: input.chain,
      tokenAddress: input.tokenAddress,
      // Same treatment as a page view: hashed with the user agent and a server
      // secret, so repeat taps are distinguishable from repeat people and the
      // address itself is never stored.
      visitorHash: input.ip ? visitorHash(input.ip, input.userAgent) : null,
      country: input.country?.slice(0, 8) ?? null,
    });
  } catch {
    // Analytics must never throw into a path a reader is waiting on.
  }
}

export interface VenueClicks {
  venue: string;
  /** Split by where the tap came from, because that is the whole question. */
  telegram24h: number;
  site24h: number;
  telegram7d: number;
  site7d: number;
  /** Distinct visitors over the week. Forty taps from one person is not reach. */
  visitors7d: number;
}

export interface TokenClicks {
  chain: string;
  tokenAddress: string;
  symbol: string | null;
  clicks24h: number;
  visitors24h: number;
}

export interface LinkClickStats {
  venues: VenueClicks[];
  tokens: TokenClicks[];
  totalTelegram24h: number;
  totalSite24h: number;
  visitors24h: number;
}

const EMPTY: LinkClickStats = {
  venues: [],
  tokens: [],
  totalTelegram24h: 0,
  totalSite24h: 0,
  visitors24h: 0,
};

/**
 * Where the outbound traffic went, by venue and by call.
 *
 * Two statements, run in sequence — never `Promise.all`, which against a pool of
 * three is a hang rather than a speed-up (see AGENTS.md). Each does all of its
 * windowing in one pass with `filter (where ...)` instead of a query per window.
 *
 * Telegram and the site are counted separately at every level. A total on its
 * own cannot tell "the channel works" from "the site works", which is the only
 * thing this table was added to answer.
 */
export async function fetchLinkClickStats(): Promise<LinkClickStats> {
  const db = getDb();
  if (!db) return EMPTY;

  const venueRows = await db.execute<{
    venue: string;
    tg_24h: number;
    site_24h: number;
    tg_7d: number;
    site_7d: number;
    visitors_7d: number;
  }>(sql`
    select
      ${linkClicks.venue} as venue,
      count(*) filter (
        where ${linkClicks.source} = 'tg' and ${linkClicks.createdAt} > now() - interval '24 hours'
      )::int as tg_24h,
      count(*) filter (
        where ${linkClicks.source} <> 'tg' and ${linkClicks.createdAt} > now() - interval '24 hours'
      )::int as site_24h,
      count(*) filter (where ${linkClicks.source} = 'tg')::int as tg_7d,
      count(*) filter (where ${linkClicks.source} <> 'tg')::int as site_7d,
      count(distinct ${linkClicks.visitorHash})::int as visitors_7d
    from ${linkClicks}
    where ${linkClicks.createdAt} > now() - interval '7 days'
    group by ${linkClicks.venue}
    order by count(*) desc
  `);

  // The symbol comes from `tokens` when a scan has ever seen the mint, and is
  // left null otherwise — an alert can fire on a token nobody has scanned, and
  // a missing ticker is not a reason to drop the row.
  const tokenRows = await db.execute<{
    chain: string;
    token_address: string;
    symbol: string | null;
    clicks_24h: number;
    visitors_24h: number;
  }>(sql`
    select
      c.chain,
      c.token_address,
      t.${sql.identifier(tokens.symbol.name)} as symbol,
      count(*)::int as clicks_24h,
      count(distinct c.visitor_hash)::int as visitors_24h
    from ${linkClicks} c
    left join ${tokens} t
      on t.${sql.identifier(tokens.chain.name)} = c.chain
     and lower(t.${sql.identifier(tokens.address.name)}) = lower(c.token_address)
    where c.created_at > now() - interval '24 hours'
    group by c.chain, c.token_address, t.${sql.identifier(tokens.symbol.name)}
    order by count(*) desc
    limit 12
  `);

  // Summing the per-venue visitor counts would double-count anybody who tapped
  // two venues, so the distinct count is taken over the whole window. Third
  // statement, still sequential.
  const visitors24h = await countVisitors24h();

  const venues: VenueClicks[] = venueRows.map((r) => ({
    venue: r.venue,
    telegram24h: r.tg_24h ?? 0,
    site24h: r.site_24h ?? 0,
    telegram7d: r.tg_7d ?? 0,
    site7d: r.site_7d ?? 0,
    visitors7d: r.visitors_7d ?? 0,
  }));

  return {
    venues,
    tokens: tokenRows.map((r) => ({
      chain: r.chain,
      tokenAddress: r.token_address,
      symbol: r.symbol,
      clicks24h: r.clicks_24h ?? 0,
      visitors24h: r.visitors_24h ?? 0,
    })),
    totalTelegram24h: venues.reduce((sum, v) => sum + v.telegram24h, 0),
    totalSite24h: venues.reduce((sum, v) => sum + v.site24h, 0),
    visitors24h,
  };
}

async function countVisitors24h(): Promise<number> {
  const db = getDb();
  if (!db) return 0;
  const [row] = await db.execute<{ n: number }>(sql`
    select count(distinct ${linkClicks.visitorHash})::int as n
    from ${linkClicks}
    where ${linkClicks.createdAt} > now() - interval '24 hours'
  `);
  return row?.n ?? 0;
}
