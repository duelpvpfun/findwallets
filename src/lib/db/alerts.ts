import "server-only";
import { and, asc, eq, inArray, isNotNull, sql } from "drizzle-orm";
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
  AGED_SAMPLE_SECONDS,
  ALERT_TIERS,
  ALERT_WINDOWS_SECONDS,
  EPISODE_GAP_SECONDS,
  EVENT_RETENTION_HOURS,
  FRESH_SAMPLE_SECONDS,
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

export async function markDelivered(
  alertId: number,
  error: string | null,
  messageId?: number | null
): Promise<void> {
  const db = getDb();
  if (!db) return;
  await db
    .update(alertsFired)
    .set({
      deliveredAt: error ? null : new Date(),
      deliveryError: error,
      telegramMessageId: messageId ?? null,
    })
    .where(eq(alertsFired.id, alertId));
}

// --- Performance tracking ---

export interface TrackingTarget {
  tokenAddress: string;
  supplyAtAlert: number | null;
}

/**
 * Tokens due for a market-cap sample, least recently checked first.
 *
 * **Sampling tapers with age.** A memecoin's peak is almost always in the first
 * day, so a token alerted in the last 24 hours is re-read every run (ten
 * minutes) and anything older once an hour. Sampling everything every ten
 * minutes for a week would cost roughly six times as much upstream for
 * resolution nobody reads — and sampling hourly from the start would miss the
 * part that matters.
 *
 * Deduplicated by token, so five calls on one token cost one price lookup.
 */
export async function fetchTrackingTokens(chain: string, limit = 400): Promise<TrackingTarget[]> {
  const db = getDb();
  if (!db) return [];

  const rows = await db.execute<{ token_address: string; supply_at_alert: number | null }>(sql`
    select
      ${alertsFired.tokenAddress} as token_address,
      max(${alertsFired.supplyAtAlert}) as supply_at_alert
    from ${alertsFired}
    where ${alertsFired.chain} = ${chain}
      and ${alertsFired.superseded} = false
      and ${alertsFired.trackedUntil} > now()
    group by ${alertsFired.tokenAddress}
    -- Seconds arithmetic rather than \`make_interval(secs => $n)\`: Postgres
    -- cannot infer a type for a bound parameter in that argument position and
    -- the whole statement fails to plan.
    having extract(epoch from (
             now() - min(coalesce(${alertsFired.lastCheckedAt}, ${alertsFired.createdAt}))
           )) > case
             when max(${alertsFired.createdAt}) > now() - interval '24 hours'
             then ${FRESH_SAMPLE_SECONDS}::float8
             else ${AGED_SAMPLE_SECONDS}::float8
           end
    order by min(coalesce(${alertsFired.lastCheckedAt}, ${alertsFired.createdAt})) asc
    limit ${limit}
  `);

  return rows.map((r) => ({
    tokenAddress: r.token_address,
    supplyAtAlert: num(r.supply_at_alert),
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
function num(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Cut a stored wallet address down to `abcd…wxyz` for public consumption.
 *
 * **This is a business boundary, not a display choice.** The curated list of
 * proven wallets IS the product — it is what a scan sells, and what took every
 * paid upstream call in the database to assemble. A public feed handing back
 * full addresses would let anyone rebuild that list for free by polling
 * `/api/feed`, and no amount of truncation in the UI would help, because
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

/** One escalation step inside a call. */
export interface AlertStep {
  tier: number;
  walletCount: number;
  spanSeconds: number;
  windowSeconds: number;
  mcapUsd: number | null;
  at: string;
}

/**
 * ONE CALL: a token, an episode, and every escalation step in it.
 *
 * A token that goes 2 -> 3 -> 4 wallets writes three `alerts_fired` rows,
 * because each step has to fire exactly once and each has its own entry market
 * cap. But it is one call, and showing it as three cards would triple-count our
 * own record and read as three separate tips on the same coin.
 *
 * So the feed groups by `(token, episode)`. The numbers are chosen to describe
 * the call honestly:
 *
 *  - `entryMcapUsd` comes from the FIRST step. That is the cap when we called
 *    it, and it is the only defensible denominator for "how much did this call
 *    make" — crediting ourselves with the 4-wallet entry after announcing at 2
 *    would be marking our own homework.
 *  - the roster, wallet count and averages come from the HIGHEST step, which is
 *    a superset of the earlier ones.
 *  - `athMcapUsd` is shared: every step of a token is sampled by the same cron
 *    pass, so the peak is a property of the token, not of the step.
 *
 * The per-tier scoreboard still reads the ungrouped rows, because "would you
 * have done better entering on the 2-wallet alert or the 4-wallet one" is a
 * real question and only the individual steps can answer it.
 */
export interface AlertFeedRow {
  id: number;
  chain: string;
  tokenAddress: string;
  tokenSymbol: string | null;
  tokenName: string | null;
  tokenImageUrl: string | null;
  episode: number;
  /** The step we announced first, and the highest reached. */
  firstTier: number;
  peakTier: number;
  steps: AlertStep[];
  /** From the highest step. */
  tier: number;
  windowSeconds: number;
  spanSeconds: number;
  walletCount: number;
  exitedCount: number;
  wallets: AlertWalletSnapshot[];
  avgMultipleX: number | null;
  avgPnlUsd: number | null;
  totalBoughtUsd: number | null;
  /** From the FIRST step — where we called it. */
  mcapAtAlertUsd: number | null;
  athMcapUsd: number | null;
  lastMcapUsd: number | null;
  athAt: string | null;
  samples: AlertMcapSample[];
  createdAt: string;
}

interface CallRow extends Record<string, unknown> {
  id: number;
  chain: string;
  token_address: string;
  token_symbol: string | null;
  token_name: string | null;
  token_image_url: string | null;
  episode: number;
  first_tier: number;
  peak_tier: number;
  steps: AlertStep[] | null;
  window_seconds: number;
  span_seconds: number;
  wallet_count: number;
  exited_count: number;
  wallets: AlertWalletSnapshot[] | null;
  avg_multiple_x: number | null;
  avg_pnl_usd: number | null;
  total_bought_usd: number | null;
  entry_mcap_usd: number | null;
  ath_mcap_usd: number | null;
  last_mcap_usd: number | null;
  ath_at: string | null;
  samples: AlertMcapSample[] | null;
  created_at: string;
}

export async function fetchAlertFeed(
  chain: string,
  limit = 50,
  beforeId?: number
): Promise<AlertFeedRow[]> {
  const db = getDb();
  if (!db) return [];

  // `(array_agg(x order by tier desc))[1]` is "the value from the highest
  // step"; `asc` is "from the first step". Doing this in SQL rather than
  // grouping in JS is what keeps `limit` meaning "N calls" — grouping after a
  // limit would split a call across a page boundary and show half of it.
  const rows = await db.execute<CallRow>(sql`
    select
      min(${alertsFired.id})::int as id,
      ${alertsFired.chain} as chain,
      ${alertsFired.tokenAddress} as token_address,
      ${alertsFired.episode} as episode,
      min(${alertsFired.tier})::int as first_tier,
      max(${alertsFired.tier})::int as peak_tier,
      min(${alertsFired.createdAt}) as created_at,

      (array_agg(${alertsFired.tokenSymbol} order by ${alertsFired.tier} desc))[1] as token_symbol,
      (array_agg(${alertsFired.tokenName} order by ${alertsFired.tier} desc))[1] as token_name,
      (array_agg(${alertsFired.tokenImageUrl} order by ${alertsFired.tier} desc))[1] as token_image_url,
      (array_agg(${alertsFired.windowSeconds} order by ${alertsFired.tier} desc))[1]::int as window_seconds,
      (array_agg(${alertsFired.spanSeconds} order by ${alertsFired.tier} desc))[1]::int as span_seconds,
      (array_agg(${alertsFired.walletCount} order by ${alertsFired.tier} desc))[1]::int as wallet_count,
      (array_agg(${alertsFired.exitedCount} order by ${alertsFired.tier} desc))[1]::int as exited_count,
      (array_agg(${alertsFired.wallets} order by ${alertsFired.tier} desc))[1] as wallets,
      (array_agg(${alertsFired.avgMultipleX} order by ${alertsFired.tier} desc))[1] as avg_multiple_x,
      (array_agg(${alertsFired.avgPnlUsd} order by ${alertsFired.tier} desc))[1] as avg_pnl_usd,
      (array_agg(${alertsFired.totalBoughtUsd} order by ${alertsFired.tier} desc))[1] as total_bought_usd,
      (array_agg(${alertsFired.samples} order by ${alertsFired.tier} desc))[1] as samples,

      -- Entry is the FIRST step's cap: where we actually called it.
      (array_agg(${alertsFired.mcapAtAlertUsd} order by ${alertsFired.tier} asc))[1] as entry_mcap_usd,

      -- Peak is a property of the token, shared by every step of the call.
      max(${alertsFired.athMcapUsd}) as ath_mcap_usd,
      max(${alertsFired.lastMcapUsd}) as last_mcap_usd,
      max(${alertsFired.athAt}) as ath_at,

      jsonb_agg(
        jsonb_build_object(
          'tier', ${alertsFired.tier},
          'walletCount', ${alertsFired.walletCount},
          'spanSeconds', ${alertsFired.spanSeconds},
          'windowSeconds', ${alertsFired.windowSeconds},
          'mcapUsd', ${alertsFired.mcapAtAlertUsd},
          'at', ${alertsFired.createdAt}
        ) order by ${alertsFired.tier}
      ) as steps
    from ${alertsFired}
    where ${alertsFired.chain} = ${chain}
      and ${alertsFired.superseded} = false
    group by ${alertsFired.chain}, ${alertsFired.tokenAddress}, ${alertsFired.episode}
    ${beforeId ? sql`having min(${alertsFired.id}) < ${beforeId}` : sql``}
    order by min(${alertsFired.id}) desc
    limit ${Math.min(limit, 100)}
  `);

  return rows.map((r) => ({
    id: Number(r.id),
    chain: r.chain,
    tokenAddress: r.token_address,
    tokenSymbol: r.token_symbol,
    tokenName: r.token_name,
    tokenImageUrl: r.token_image_url,
    episode: Number(r.episode),
    firstTier: Number(r.first_tier),
    peakTier: Number(r.peak_tier),
    steps: r.steps ?? [],
    tier: Number(r.peak_tier),
    windowSeconds: Number(r.window_seconds),
    spanSeconds: Number(r.span_seconds),
    walletCount: Number(r.wallet_count),
    exitedCount: Number(r.exited_count),
    // Masked here, at the read that serves the public endpoint.
    wallets: (r.wallets ?? []).map((w) => ({ ...w, address: maskAddress(w.address) })),
    avgMultipleX: num(r.avg_multiple_x),
    avgPnlUsd: num(r.avg_pnl_usd),
    totalBoughtUsd: num(r.total_bought_usd),
    mcapAtAlertUsd: num(r.entry_mcap_usd),
    athMcapUsd: num(r.ath_mcap_usd),
    lastMcapUsd: num(r.last_mcap_usd),
    athAt: r.ath_at ? new Date(r.ath_at).toISOString() : null,
    samples: r.samples ?? [],
    createdAt: new Date(r.created_at).toISOString(),
  }));
}

/**
 * The Telegram message id of the first announced step of a call, so a later
 * escalation replies to it instead of arriving as an unrelated post.
 */
export async function fetchCallAnchorMessageId(
  chain: string,
  tokenAddress: string,
  episode: number
): Promise<number | null> {
  const db = getDb();
  if (!db) return null;
  const [row] = await db
    .select({ messageId: alertsFired.telegramMessageId })
    .from(alertsFired)
    .where(
      and(
        eq(alertsFired.chain, chain),
        eq(alertsFired.tokenAddress, tokenAddress),
        eq(alertsFired.episode, episode),
        eq(alertsFired.superseded, false),
        isNotNull(alertsFired.telegramMessageId)
      )
    )
    .orderBy(asc(alertsFired.tier))
    .limit(1);
  return row?.messageId ?? null;
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
