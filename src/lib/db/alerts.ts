import "server-only";
import { and, asc, desc, eq, inArray, lt, sql } from "drizzle-orm";
import { getDb } from "./index";
import {
  alertState,
  alertsFired,
  alertWallets,
  walletEvents,
  type AlertMcapSample,
  type AlertWalletSnapshot,
} from "./schema";
import {
  ALERT_TIERS,
  ALERT_WINDOWS_SECONDS,
  EPISODE_GAP_SECONDS,
  EVENT_RETENTION_HOURS,
  LONGEST_WINDOW_SECONDS,
  MAX_SAMPLES,
  MIN_BUY_USD,
  MIN_SCOREBOARD_MCAP_USD,
  TRACKING_DAYS,
  type AlertTier,
} from "../alerts/config";
import type { ClassifiedEvent } from "../alerts/classify";

/**
 * Every database call the alert engine makes.
 *
 * Most of it runs on the webhook hot path, which means the rule from AGENTS.md
 * applies with no exceptions: **never `Promise.all` these**. postgres.js runs a
 * pool of 3 against Supabase's transaction pooler, and a fan-out wider than the
 * pool does not queue — it stops answering, and the request hangs until the
 * platform kills it. Every function here is written to be awaited in sequence,
 * and each does as much as possible in one statement precisely so that the
 * sequence stays short.
 */

// --- Roster ---

export interface RosterEntry {
  address: string;
  label: string | null;
  twitter: string | null;
  avgMultipleX: number | null;
  avgPnlUsd: number | null;
  bestMultipleX: number | null;
  bestSymbol: string | null;
}

/**
 * Resolve only the addresses that actually appeared in this webhook delivery.
 * Loading the whole roster per POST would be ~1,800 rows several times a
 * second; this is a handful of rows off a unique index.
 */
export async function fetchRoster(
  chain: string,
  addresses: string[]
): Promise<Map<string, RosterEntry>> {
  const found = new Map<string, RosterEntry>();
  const db = getDb();
  if (!db || addresses.length === 0) return found;

  const rows = await db
    .select({
      address: alertWallets.address,
      label: alertWallets.label,
      twitter: alertWallets.twitter,
      avgMultipleX: alertWallets.avgMultipleX,
      avgPnlUsd: alertWallets.avgPnlUsd,
      bestMultipleX: alertWallets.bestMultipleX,
      bestSymbol: alertWallets.bestSymbol,
    })
    .from(alertWallets)
    .where(
      and(
        eq(alertWallets.chain, chain),
        eq(alertWallets.active, true),
        inArray(alertWallets.address, addresses)
      )
    );

  for (const row of rows) found.set(row.address, row);
  return found;
}

/** Every active address, for the Helius address-list sync. Deliberately not
 * called from the webhook path. */
export async function fetchRosterAddresses(chain: string): Promise<string[]> {
  const db = getDb();
  if (!db) return [];
  const rows = await db
    .select({ address: alertWallets.address })
    .from(alertWallets)
    .where(and(eq(alertWallets.chain, chain), eq(alertWallets.active, true)));
  return rows.map((r) => r.address);
}

// --- Events ---

/**
 * Insert classified trades, returning only the ones that were genuinely new.
 *
 * The unique index is the whole mechanism: Helius retries every non-2xx
 * delivery, and one transaction reaches us once per tracked wallet in it. A
 * read-then-write here would let a retry double-count a wallet and fire a tier
 * off a single buy, so this must stay a single `ON CONFLICT DO NOTHING`.
 */
export async function insertEvents(
  chain: string,
  events: ClassifiedEvent[]
): Promise<Array<{ tokenAddress: string; walletAddress: string; side: string }>> {
  const db = getDb();
  if (!db || events.length === 0) return [];

  // One statement cannot touch the same key twice, and the same wallet can swap
  // the same token twice inside one Helius batch.
  const seen = new Set<string>();
  const values = [];
  for (const e of events) {
    const key = `${e.signature} ${e.wallet} ${e.mint} ${e.side}`;
    if (seen.has(key)) continue;
    seen.add(key);
    values.push({
      chain,
      txSignature: e.signature,
      walletAddress: e.wallet,
      tokenAddress: e.mint,
      side: e.side,
      amountUsd: e.amountUsd,
      tokenAmount: e.tokenAmount,
      priceUsd: e.priceUsd,
      blockTime: e.blockTime,
    });
  }
  if (values.length === 0) return [];

  return db
    .insert(walletEvents)
    .values(values)
    .onConflictDoNothing()
    .returning({
      tokenAddress: walletEvents.tokenAddress,
      walletAddress: walletEvents.walletAddress,
      side: walletEvents.side,
    });
}

// --- Escalation state ---

/**
 * Current episode for a token, rolling it forward if the token has been quiet.
 *
 * One upsert rather than a read and a write: two wallets buying the same token
 * in the same second arrive as two concurrent webhook deliveries, and a
 * read-then-write would let both read episode 4 and race on the unique index.
 */
export async function currentEpisode(chain: string, tokenAddress: string): Promise<number> {
  const db = getDb();
  if (!db) return 1;

  const [row] = await db
    .insert(alertState)
    .values({ chain, tokenAddress, episode: 1 })
    .onConflictDoUpdate({
      target: [alertState.chain, alertState.tokenAddress],
      set: {
        episode: sql`case
          when now() - ${alertState.lastEventAt} > make_interval(secs => ${EPISODE_GAP_SECONDS})
          then ${alertState.episode} + 1
          else ${alertState.episode}
        end`,
        lastEventAt: sql`now()`,
      },
    })
    .returning({ episode: alertState.episode });

  return row?.episode ?? 1;
}

// --- Windows ---

/** Distinct buying wallets per configured window, keyed by window length. */
export type WindowCounts = Record<number, number>;

/**
 * One query, one row: the distinct-wallet count in every window at once.
 *
 * Counting each window separately would be three round trips per token per
 * delivery, and running those concurrently is exactly the fan-out that hangs
 * the pooler. Filtered aggregates get all of them off a single index scan.
 */
export async function countWindows(chain: string, tokenAddress: string): Promise<WindowCounts> {
  const db = getDb();
  if (!db) return {};

  const projections = ALERT_WINDOWS_SECONDS.map(
    (secs) => sql`count(distinct ${walletEvents.walletAddress}) filter (
      where ${walletEvents.blockTime} > now() - make_interval(secs => ${secs})
    )::int as ${sql.raw(`w_${secs}`)}`
  );

  const rows = await db.execute<Record<string, number>>(sql`
    select ${sql.join(projections, sql`, `)}
    from ${walletEvents}
    where ${walletEvents.chain} = ${chain}
      and ${walletEvents.tokenAddress} = ${tokenAddress}
      and ${walletEvents.side} = 'buy'
      and ${walletEvents.amountUsd} >= ${MIN_BUY_USD}
      and ${walletEvents.blockTime} > now() - make_interval(secs => ${LONGEST_WINDOW_SECONDS})
  `);

  const raw = rows[0] ?? {};
  const counts: WindowCounts = {};
  for (const secs of ALERT_WINDOWS_SECONDS) counts[secs] = Number(raw[`w_${secs}`] ?? 0);
  return counts;
}

/**
 * The highest tier this token has reached, or null.
 *
 * Only the highest is returned. Two wallets buying within a second of each
 * other can cross tier 2 and tier 3 in the same delivery, and announcing both
 * would put two messages about the same token in the channel one line apart.
 * The caller claims the lower tiers silently so they can never fire afterwards
 * on a smaller count.
 */
export function highestTierReached(counts: WindowCounts): AlertTier | null {
  let best: AlertTier | null = null;
  for (const tier of ALERT_TIERS) {
    if ((counts[tier.windowSeconds] ?? 0) >= tier.wallets) best = tier;
  }
  return best;
}

export interface WindowBuyer {
  walletAddress: string;
  firstBuy: Date;
  boughtUsd: number;
  buyCount: number;
  /** Sold at least part of the position after buying it. Still counts toward
   * the tier — the owner's call, and the right one: the entry is the signal,
   * and a fast flip is information the reader deserves either way. */
  exited: boolean;
}

/**
 * Who is in the window, when they first bought, and whether they have already
 * sold.
 *
 * Repeat buys collapse to one row per wallet: a wallet scaling into a position
 * over four transactions is one wallet, not four, or a single trader could fire
 * every tier on their own. The size shown is everything they put in during the
 * window, which is strictly more informative and changes no count.
 */
export async function fetchWindowBuyers(
  chain: string,
  tokenAddress: string,
  windowSeconds: number
): Promise<WindowBuyer[]> {
  const db = getDb();
  if (!db) return [];

  const rows = await db.execute<{
    wallet_address: string;
    first_buy: string;
    bought_usd: number;
    buy_count: number;
    exited: boolean;
  }>(sql`
    with buys as (
      select
        ${walletEvents.walletAddress} as wallet_address,
        min(${walletEvents.blockTime}) as first_buy,
        sum(${walletEvents.amountUsd})::float8 as bought_usd,
        count(*)::int as buy_count
      from ${walletEvents}
      where ${walletEvents.chain} = ${chain}
        and ${walletEvents.tokenAddress} = ${tokenAddress}
        and ${walletEvents.side} = 'buy'
        and ${walletEvents.amountUsd} >= ${MIN_BUY_USD}
        and ${walletEvents.blockTime} > now() - make_interval(secs => ${windowSeconds})
      group by 1
    ),
    sells as (
      select
        ${walletEvents.walletAddress} as wallet_address,
        max(${walletEvents.blockTime}) as last_sell
      from ${walletEvents}
      where ${walletEvents.chain} = ${chain}
        and ${walletEvents.tokenAddress} = ${tokenAddress}
        and ${walletEvents.side} = 'sell'
      group by 1
    )
    select
      b.wallet_address,
      b.first_buy,
      b.bought_usd,
      b.buy_count,
      coalesce(s.last_sell > b.first_buy, false) as exited
    from buys b
    left join sells s on s.wallet_address = b.wallet_address
    order by b.first_buy asc
  `);

  return rows.map((r) => ({
    walletAddress: r.wallet_address,
    firstBuy: new Date(r.first_buy),
    boughtUsd: Number(r.bought_usd),
    buyCount: Number(r.buy_count),
    exited: Boolean(r.exited),
  }));
}

// --- Firing ---

export interface ClaimedAlert {
  id: number;
  tier: number;
  episode: number;
}

export interface FireInput {
  chain: string;
  tokenAddress: string;
  tier: AlertTier;
  episode: number;
  spanSeconds: number;
  wallets: AlertWalletSnapshot[];
  exitedCount: number;
  avgMultipleX: number | null;
  avgPnlUsd: number | null;
  totalBoughtUsd: number;
}

/**
 * Claim a tier. Returns null when it was already claimed for this token and
 * episode, which is what makes each escalation step announce exactly once.
 *
 * Lower tiers are claimed in the same statement, marked `superseded`, so a tier
 * jumped over by a burst can never fire afterwards on a smaller count. They are
 * excluded from the feed and from every performance figure.
 */
export async function claimTier(input: FireInput): Promise<ClaimedAlert | null> {
  const db = getDb();
  if (!db) return null;

  const trackedUntil = new Date(Date.now() + TRACKING_DAYS * 24 * 60 * 60 * 1000);
  const lower = ALERT_TIERS.filter((t) => t.wallets < input.tier.wallets);

  const rows = await db
    .insert(alertsFired)
    .values([
      ...lower.map((t) => ({
        chain: input.chain,
        tokenAddress: input.tokenAddress,
        tier: t.wallets,
        episode: input.episode,
        windowSeconds: t.windowSeconds,
        walletCount: input.wallets.length,
        superseded: true,
        trackedUntil,
      })),
      {
        chain: input.chain,
        tokenAddress: input.tokenAddress,
        tier: input.tier.wallets,
        episode: input.episode,
        windowSeconds: input.tier.windowSeconds,
        spanSeconds: input.spanSeconds,
        walletCount: input.wallets.length,
        wallets: input.wallets,
        exitedCount: input.exitedCount,
        avgMultipleX: input.avgMultipleX,
        avgPnlUsd: input.avgPnlUsd,
        totalBoughtUsd: input.totalBoughtUsd,
        superseded: false,
        trackedUntil,
      },
    ])
    .onConflictDoNothing()
    .returning({
      id: alertsFired.id,
      tier: alertsFired.tier,
      episode: alertsFired.episode,
      superseded: alertsFired.superseded,
    });

  const announced = rows.find((r) => !r.superseded);
  return announced ? { id: announced.id, tier: announced.tier, episode: announced.episode } : null;
}

/**
 * Attach the token identity and the market cap the alert fired at.
 *
 * Separate from `claimTier` on purpose: the claim has to win its race before we
 * spend an upstream call on metadata for a token that turns out to be a
 * duplicate.
 */
export async function attachTokenSnapshot(
  alertId: number,
  snapshot: {
    symbol: string | null;
    name: string | null;
    imageUrl: string | null;
    priceUsd: number | null;
    mcapUsd: number | null;
    supply: number | null;
  }
): Promise<void> {
  const db = getDb();
  if (!db) return;

  const now = new Date();
  const hasMcap = typeof snapshot.mcapUsd === "number" && snapshot.mcapUsd > 0;
  const samples: AlertMcapSample[] = hasMcap
    ? [[Math.floor(now.getTime() / 1000), snapshot.mcapUsd as number]]
    : [];

  await db
    .update(alertsFired)
    .set({
      tokenSymbol: snapshot.symbol,
      tokenName: snapshot.name,
      tokenImageUrl: snapshot.imageUrl,
      priceAtAlertUsd: snapshot.priceUsd,
      mcapAtAlertUsd: snapshot.mcapUsd,
      supplyAtAlert: snapshot.supply,
      athMcapUsd: snapshot.mcapUsd,
      athAt: hasMcap ? now : null,
      lastMcapUsd: snapshot.mcapUsd,
      samples,
      lastCheckedAt: now,
    })
    .where(eq(alertsFired.id, alertId));
}

export async function markDelivered(alertId: number, error: string | null): Promise<void> {
  const db = getDb();
  if (!db) return;
  await db
    .update(alertsFired)
    .set({ deliveredAt: error ? null : new Date(), deliveryError: error })
    .where(eq(alertsFired.id, alertId));
}

// --- Performance tracking ---

export interface TrackingTarget {
  tokenAddress: string;
  supplyAtAlert: number | null;
}

/**
 * Distinct tokens still inside their tracking window, least recently checked
 * first. Deduplicated, so five alerts on one token cost one price lookup rather
 * than five.
 */
export async function fetchTrackingTokens(chain: string, limit = 300): Promise<TrackingTarget[]> {
  const db = getDb();
  if (!db) return [];

  const rows = await db
    .select({
      tokenAddress: alertsFired.tokenAddress,
      supplyAtAlert: sql<number | null>`max(${alertsFired.supplyAtAlert})`,
    })
    .from(alertsFired)
    .where(
      and(
        eq(alertsFired.chain, chain),
        eq(alertsFired.superseded, false),
        sql`${alertsFired.trackedUntil} > now()`
      )
    )
    .groupBy(alertsFired.tokenAddress)
    .orderBy(asc(sql`min(coalesce(${alertsFired.lastCheckedAt}, ${alertsFired.createdAt}))`))
    .limit(limit);

  return rows.map((r) => ({
    tokenAddress: r.tokenAddress,
    supplyAtAlert: r.supplyAtAlert === null ? null : Number(r.supplyAtAlert),
  }));
}

/**
 * Fold one market-cap reading into every open alert on that token.
 *
 * `greatest` is what keeps the peak: the running maximum is the number the
 * whole scoreboard is built on, so it can only ever move up, and a transient
 * bad price can never erase a real high. One statement per token, and the
 * series is trimmed in the same statement so it cannot grow without bound.
 */
export async function applyMcapSample(
  chain: string,
  tokenAddress: string,
  mcapUsd: number,
  priceUsd: number
): Promise<number> {
  const db = getDb();
  if (!db || !(mcapUsd > 0)) return 0;

  const appended = JSON.stringify([[Math.floor(Date.now() / 1000), mcapUsd]]);

  const rows = await db
    .update(alertsFired)
    .set({
      lastMcapUsd: mcapUsd,
      lastCheckedAt: new Date(),
      athMcapUsd: sql`greatest(coalesce(${alertsFired.athMcapUsd}, 0), ${mcapUsd})`,
      // Only stamp a new peak time when the peak actually moved.
      athAt: sql`case
        when ${mcapUsd} > coalesce(${alertsFired.athMcapUsd}, 0) then now()
        else ${alertsFired.athAt}
      end`,
      // Append, then keep the newest MAX_SAMPLES in chronological order.
      samples: sql`coalesce((
        select jsonb_agg(entry order by ord)
        from (
          select entry, ord
          from jsonb_array_elements(${alertsFired.samples} || ${appended}::jsonb)
               with ordinality as t(entry, ord)
          order by ord desc
          limit ${MAX_SAMPLES}
        ) newest
      ), '[]'::jsonb)`,
      priceAtAlertUsd: sql`coalesce(${alertsFired.priceAtAlertUsd}, ${priceUsd})`,
    })
    .where(
      and(
        eq(alertsFired.chain, chain),
        eq(alertsFired.tokenAddress, tokenAddress),
        eq(alertsFired.superseded, false),
        sql`${alertsFired.trackedUntil} > now()`
      )
    )
    .returning({ id: alertsFired.id });

  return rows.length;
}

/** Drop expired events. Retention is part of v1: unpruned this table is
 * 60k-500k rows a day and the window scans get slower every hour. */
export async function pruneEvents(): Promise<number> {
  const db = getDb();
  if (!db) return 0;
  const rows = await db
    .delete(walletEvents)
    .where(sql`${walletEvents.blockTime} < now() - make_interval(hours => ${EVENT_RETENTION_HOURS})`)
    .returning({ id: walletEvents.id });
  return rows.length;
}

/**
 * Seconds since the most recent recorded event, or null if there has never been
 * one.
 *
 * This is the heartbeat. Helius silently auto-disables a webhook whose receiver
 * keeps failing — it has already done so once on this account — and the failure
 * mode is a dashboard that looks perfectly healthy while no alerts fire.
 */
export async function secondsSinceLastEvent(chain: string): Promise<number | null> {
  const db = getDb();
  if (!db) return null;
  const [row] = await db
    .select({
      age: sql<number | null>`extract(epoch from (now() - max(${walletEvents.createdAt})))::int`,
    })
    .from(walletEvents)
    .where(eq(walletEvents.chain, chain));
  const age = row?.age;
  return age === null || age === undefined ? null : Number(age);
}

// --- Reads for the public feed ---

/**
 * One alert as the PUBLIC feed sees it. Wallet addresses on this shape are
 * masked (`abcd…wxyz`) and are not resolvable — see `maskAddress`. Anything
 * that needs a real address must read `alerts_fired.wallets` directly.
 */
export interface AlertFeedRow {
  id: number;
  chain: string;
  tokenAddress: string;
  tokenSymbol: string | null;
  tokenName: string | null;
  tokenImageUrl: string | null;
  tier: number;
  windowSeconds: number;
  spanSeconds: number;
  walletCount: number;
  exitedCount: number;
  wallets: AlertWalletSnapshot[];
  avgMultipleX: number | null;
  avgPnlUsd: number | null;
  totalBoughtUsd: number | null;
  mcapAtAlertUsd: number | null;
  athMcapUsd: number | null;
  lastMcapUsd: number | null;
  athAt: string | null;
  samples: AlertMcapSample[];
  createdAt: string;
}

/**
 * Cut a stored wallet address down to `abcd…wxyz` for public consumption.
 *
 * **This is a business boundary, not a display choice.** The curated list of
 * proven wallets IS the product — it is what a scan sells, and what took every
 * paid upstream call in the database to assemble. A public feed handing back
 * full addresses would let anyone rebuild that list for free by polling
 * `/api/alerts/feed`, and no amount of truncation in the UI would help, because
 * the addresses would still be sitting in the JSON.
 *
 * So it happens here, at the read that serves the public endpoint, and the
 * stored `alerts_fired.wallets` keeps the full address for our own use. Enough
 * is shown to prove the alert names real, distinct wallets; not enough to
 * follow one.
 */
function maskAddress(address: string): string {
  return address.length <= 12 ? address : `${address.slice(0, 4)}…${address.slice(-4)}`;
}

export async function fetchAlertFeed(
  chain: string,
  limit = 50,
  beforeId?: number
): Promise<AlertFeedRow[]> {
  const db = getDb();
  if (!db) return [];

  const rows = await db
    .select({
      id: alertsFired.id,
      chain: alertsFired.chain,
      tokenAddress: alertsFired.tokenAddress,
      tokenSymbol: alertsFired.tokenSymbol,
      tokenName: alertsFired.tokenName,
      tokenImageUrl: alertsFired.tokenImageUrl,
      tier: alertsFired.tier,
      windowSeconds: alertsFired.windowSeconds,
      spanSeconds: alertsFired.spanSeconds,
      walletCount: alertsFired.walletCount,
      exitedCount: alertsFired.exitedCount,
      wallets: alertsFired.wallets,
      avgMultipleX: alertsFired.avgMultipleX,
      avgPnlUsd: alertsFired.avgPnlUsd,
      totalBoughtUsd: alertsFired.totalBoughtUsd,
      mcapAtAlertUsd: alertsFired.mcapAtAlertUsd,
      athMcapUsd: alertsFired.athMcapUsd,
      lastMcapUsd: alertsFired.lastMcapUsd,
      athAt: alertsFired.athAt,
      samples: alertsFired.samples,
      createdAt: alertsFired.createdAt,
    })
    .from(alertsFired)
    .where(
      and(
        eq(alertsFired.chain, chain),
        eq(alertsFired.superseded, false),
        beforeId ? lt(alertsFired.id, beforeId) : undefined
      )
    )
    .orderBy(desc(alertsFired.id))
    .limit(Math.min(limit, 100));

  return rows.map((r) => ({
    ...r,
    wallets: (r.wallets ?? []).map((w) => ({ ...w, address: maskAddress(w.address) })),
    samples: r.samples ?? [],
    athAt: r.athAt ? r.athAt.toISOString() : null,
    createdAt: r.createdAt.toISOString(),
  }));
}

/**
 * Per-tier performance. This is the question the whole tracking apparatus
 * exists to answer: which shape of alert is actually worth acting on.
 *
 * `peakX` is peak market cap over the cap at the moment the alert fired — the
 * best a reader could have done, not what anyone did do. Alerts that fired
 * below `MIN_SCOREBOARD_MCAP_USD` are excluded: a $3K cap doubling is one buy,
 * and a handful of those would flatter every average here into fiction.
 */
export interface TierScore {
  tier: number;
  windowSeconds: number;
  label: string;
  kind: AlertTier["kind"];
  alerts: number;
  scored: number;
  avgPeakX: number | null;
  medianPeakX: number | null;
  bestPeakX: number | null;
  /** Share that at least doubled from the alert cap. */
  hitRate2x: number | null;
  /** Share still above where it fired. */
  greenRate: number | null;
}

function num(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export async function fetchTierScoreboard(chain: string, days = 30): Promise<TierScore[]> {
  const db = getDb();
  if (!db) return [];

  const rows = await db.execute<{
    tier: number;
    alerts: number;
    scored: number;
    avg_peak_x: number | null;
    median_peak_x: number | null;
    best_peak_x: number | null;
    hit_2x: number | null;
    green: number | null;
  }>(sql`
    with scored as (
      select
        ${alertsFired.tier} as tier,
        case
          when ${alertsFired.mcapAtAlertUsd} >= ${MIN_SCOREBOARD_MCAP_USD}
           and ${alertsFired.athMcapUsd} is not null
          then ${alertsFired.athMcapUsd} / ${alertsFired.mcapAtAlertUsd}
        end as peak_x,
        case
          when ${alertsFired.mcapAtAlertUsd} >= ${MIN_SCOREBOARD_MCAP_USD}
           and ${alertsFired.lastMcapUsd} is not null
          then ${alertsFired.lastMcapUsd} / ${alertsFired.mcapAtAlertUsd}
        end as now_x
      from ${alertsFired}
      where ${alertsFired.chain} = ${chain}
        and ${alertsFired.superseded} = false
        and ${alertsFired.createdAt} > now() - make_interval(days => ${days})
    )
    select
      tier,
      count(*)::int as alerts,
      count(peak_x)::int as scored,
      avg(peak_x)::float8 as avg_peak_x,
      percentile_cont(0.5) within group (order by peak_x)::float8 as median_peak_x,
      max(peak_x)::float8 as best_peak_x,
      (count(*) filter (where peak_x >= 2)::float8 / nullif(count(peak_x), 0)) as hit_2x,
      (count(*) filter (where now_x >= 1)::float8 / nullif(count(now_x), 0)) as green
    from scored
    group by tier
  `);

  const byTier = new Map(rows.map((r) => [Number(r.tier), r]));

  return ALERT_TIERS.map((t) => {
    const row = byTier.get(t.wallets);
    return {
      tier: t.wallets,
      windowSeconds: t.windowSeconds,
      label: t.label,
      kind: t.kind,
      alerts: Number(row?.alerts ?? 0),
      scored: Number(row?.scored ?? 0),
      avgPeakX: num(row?.avg_peak_x),
      medianPeakX: num(row?.median_peak_x),
      bestPeakX: num(row?.best_peak_x),
      hitRate2x: num(row?.hit_2x),
      greenRate: num(row?.green),
    };
  });
}

/** Headline counters for the page. */
export interface AlertSummary {
  trackedWallets: number;
  alerts24h: number;
  alertsTotal: number;
  bestPeakX: number | null;
  avgPeakX: number | null;
  lastAlertAt: string | null;
}

export async function fetchAlertSummary(chain: string): Promise<AlertSummary> {
  const db = getDb();
  if (!db) {
    return {
      trackedWallets: 0,
      alerts24h: 0,
      alertsTotal: 0,
      bestPeakX: null,
      avgPeakX: null,
      lastAlertAt: null,
    };
  }

  // Sequential, not Promise.all. See the note at the top of this file.
  const [roster] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(alertWallets)
    .where(and(eq(alertWallets.chain, chain), eq(alertWallets.active, true)));

  const [row] = await db.execute<{
    alerts_24h: number;
    alerts_total: number;
    best_peak_x: number | null;
    avg_peak_x: number | null;
    last_alert_at: string | null;
  }>(sql`
    select
      count(*) filter (where ${alertsFired.createdAt} > now() - interval '24 hours')::int as alerts_24h,
      count(*)::int as alerts_total,
      max(case when ${alertsFired.mcapAtAlertUsd} >= ${MIN_SCOREBOARD_MCAP_USD}
               then ${alertsFired.athMcapUsd} / ${alertsFired.mcapAtAlertUsd} end)::float8 as best_peak_x,
      avg(case when ${alertsFired.mcapAtAlertUsd} >= ${MIN_SCOREBOARD_MCAP_USD}
               then ${alertsFired.athMcapUsd} / ${alertsFired.mcapAtAlertUsd} end)::float8 as avg_peak_x,
      max(${alertsFired.createdAt}) as last_alert_at
    from ${alertsFired}
    where ${alertsFired.chain} = ${chain} and ${alertsFired.superseded} = false
  `);

  return {
    trackedWallets: Number(roster?.n ?? 0),
    alerts24h: Number(row?.alerts_24h ?? 0),
    alertsTotal: Number(row?.alerts_total ?? 0),
    bestPeakX: num(row?.best_peak_x),
    avgPeakX: num(row?.avg_peak_x),
    lastAlertAt: row?.last_alert_at ? new Date(row.last_alert_at).toISOString() : null,
  };
}
