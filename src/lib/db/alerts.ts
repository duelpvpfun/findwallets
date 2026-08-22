import "server-only";
import { and, asc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { getDb } from "./index";
import {
  alertState,
  alertsFired,
  alertWallets,
  botMessages,
  walletEvents,
  type AlertMcapSample,
  type AlertWalletSnapshot,
} from "./schema";
import {
  AGED_SAMPLE_SECONDS,
  ALERT_TIERS,
  DEAD_MCAP_USD,
  ALERT_WINDOWS_SECONDS,
  EPISODE_GAP_SECONDS,
  EVENT_RETENTION_HOURS,
  FRESH_SAMPLE_SECONDS,
  LONGEST_WINDOW_SECONDS,
  MAX_SAMPLES,
  MAX_ALERT_MCAP_USD,
  MIN_ALERT_MCAP_USD,
  MIN_BUY_USD,
  MIN_SCOREBOARD_MCAP_USD,
  PIN_MIN_MCAP_USD,
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
      // NOT seeded from the entry cap. Doing that produced "called at $3.2K,
      // peak $3.2K" on a call seconds old — a peak nobody had observed, only
      // assumed. The first real sample sets it.
      athMcapUsd: null,
      athAt: null,
      lowMcapUsd: null,
      lowAt: null,
      lastMcapUsd: snapshot.mcapUsd,
      samples,
      lastCheckedAt: now,
    })
    .where(eq(alertsFired.id, alertId));
}

/**
 * Take a claimed tier out of the record because the market cap was outside the
 * band when it fired. It keeps its claim, so it can never fire again on the
 * same count, and it keeps the cap it was rejected at — without that there is
 * no way to check whether the band is set sensibly.
 */
export async function markOutOfBand(alertId: number, mcapUsd: number): Promise<void> {
  const db = getDb();
  if (!db) return;
  await db
    .update(alertsFired)
    .set({
      outOfBand: true,
      mcapAtAlertUsd: mcapUsd > 0 ? mcapUsd : null,
      deliveryError: "out-of-band",
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
      and ${alertsFired.outOfBand} = false
      and ${alertsFired.trackedUntil} > now()
    group by ${alertsFired.tokenAddress}
    -- Abandon tokens that have died: most never come back, and re-reading them
    -- every ten minutes for a week is the bulk of the tracking spend for no
    -- information. max() so one still-live call keeps the token tracked.
    --
    -- Seconds arithmetic rather than make_interval(secs => $n): Postgres cannot
    -- infer a type for a bound parameter in that argument position, and the
    -- whole statement then fails to plan.
    having max(coalesce(${alertsFired.lastMcapUsd}, ${alertsFired.mcapAtAlertUsd}, 0)) >= ${DEAD_MCAP_USD}
       and extract(epoch from (
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
      // The drawdown. `least` mirrors the peak's `greatest`, so it only ever
      // moves down and a transient bad print cannot erase a real low.
      lowMcapUsd: sql`least(coalesce(${alertsFired.lowMcapUsd}, ${alertsFired.mcapAtAlertUsd}, ${mcapUsd}), ${mcapUsd})`,
      lowAt: sql`case
        when ${mcapUsd} < coalesce(${alertsFired.lowMcapUsd}, ${alertsFired.mcapAtAlertUsd}, ${mcapUsd}) then now()
        else ${alertsFired.lowAt}
      end`,
      // Snapshotted once, on the first sample at or after each age. Sampling is
      // every ten minutes for the first day, so each lands within ten minutes
      // of its mark.
      mcap1hUsd: sql`case
        when ${alertsFired.mcap1hUsd} is null and ${alertsFired.createdAt} <= now() - interval '1 hour'
        then ${mcapUsd} else ${alertsFired.mcap1hUsd} end`,
      mcap6hUsd: sql`case
        when ${alertsFired.mcap6hUsd} is null and ${alertsFired.createdAt} <= now() - interval '6 hours'
        then ${mcapUsd} else ${alertsFired.mcap6hUsd} end`,
      mcap24hUsd: sql`case
        when ${alertsFired.mcap24hUsd} is null and ${alertsFired.createdAt} <= now() - interval '24 hours'
        then ${mcapUsd} else ${alertsFired.mcap24hUsd} end`,
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
        eq(alertsFired.outOfBand, false),
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
  /** The drawdown, so the feed can show the peak's counterweight. */
  lowMcapUsd: number | null;
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
  low_mcap_usd: number | null;
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
      min(${alertsFired.lowMcapUsd}) as low_mcap_usd,
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
      and ${alertsFired.outOfBand} = false
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
    lowMcapUsd: num(r.low_mcap_usd),
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
        eq(alertsFired.outOfBand, false),
        isNotNull(alertsFired.telegramMessageId)
      )
    )
    .orderBy(asc(alertsFired.tier))
    .limit(1);
  return row?.messageId ?? null;
}

/**
 * Per-tier performance: how many good calls a tier produces, and how big.
 *
 * The owner's framing, and the right one for this asset class: memecoins mostly
 * go to zero, so the downside is near-constant and carries almost no
 * information. What varies — and what decides whether a tier is worth reading —
 * is how OFTEN it produces a runner and how far those run. So this counts hits
 * at 2x, 5x and 10x, normalises to calls per day so tiers that fire at wildly
 * different rates are comparable, and reports the median peak *of the winners*
 * rather than of everything.
 *
 * `medianWinnerPeakX` is deliberately conditional on having hit 2x. A median
 * over all calls is ~1.00x in a market where most calls do nothing, which tells
 * you nothing about the ones that worked.
 *
 * The drawdown is still recorded (it costs nothing — the same sample writes it)
 * and is still surfaced per call in the feed, so a "hit" can always be checked
 * against how rough the ride was. It is just not what this table is about.
 *
 * Out-of-band and superseded rows are excluded, as is anything that fired below
 * `MIN_SCOREBOARD_MCAP_USD`.
 */
export interface TierScore {
  tier: number;
  windowSeconds: number;
  label: string;
  kind: AlertTier["kind"];
  /** Rows in this tier over the window. */
  alerts: number;
  /** Rows with both a usable entry cap and an observed peak. */
  scored: number;
  callsPerDay: number;
  hits2x: number;
  hits5x: number;
  hits10x: number;
  /** Good calls per day: the headline. */
  hits2xPerDay: number;
  /** Share of scored calls that reached 2x. */
  hitRate2x: number | null;
  /** Median peak among calls that reached 2x. */
  medianWinnerPeakX: number | null;
  bestPeakX: number | null;
  /**
   * Median minutes from firing to the peak being observed, among the winners.
   *
   * The peak alone cannot tell an operator whether a tier is tradeable. "6.4x,
   * 25 minutes to get there" and "6.4x, 40 seconds" are the same number and
   * completely different products, and only one of them a reader in a channel
   * could have acted on.
   */
  medianMinutesToPeakX: number | null;
  /**
   * Median multiple 24 hours in, over ALL scored calls in the tier.
   *
   * Deliberately not conditional on having won: this is the "what would holding
   * have paid" figure, and the honest version of it includes the calls that went
   * to zero. Nobody sells the top, so the peak is the ceiling and this is the
   * floor of a realistic answer. Null until the tier has calls a day old.
   */
  median24hX: number | null;
  /** Scored calls old enough to have a 24h reading, so a null above is legible
   * as "too early" rather than "no edge". */
  scored24h: number;
}

export async function fetchTierScoreboard(chain: string, days = 30): Promise<TierScore[]> {
  const db = getDb();
  if (!db) return [];

  const rows = await db.execute<{
    tier: number;
    alerts: number;
    scored: number;
    hits_2x: number;
    hits_5x: number;
    hits_10x: number;
    median_winner_peak_x: number | null;
    best_peak_x: number | null;
    median_minutes_to_peak_x: number | null;
    median_24h_x: number | null;
    scored_24h: number;
    span_days: number | null;
  }>(sql`
    with scored as (
      select
        ${alertsFired.tier} as tier,
        ${alertsFired.createdAt} as created_at,
        -- Only calls with an OBSERVED peak. A call minutes old has no peak yet,
        -- and counting it as a miss would understate every tier.
        case when ${alertsFired.mcapAtAlertUsd} >= ${MIN_SCOREBOARD_MCAP_USD}
              and ${alertsFired.athMcapUsd} is not null
             then ${alertsFired.athMcapUsd} / ${alertsFired.mcapAtAlertUsd} end as peak_x,
        case when ${alertsFired.mcapAtAlertUsd} >= ${MIN_SCOREBOARD_MCAP_USD}
              and ${alertsFired.mcap24hUsd} is not null
             then ${alertsFired.mcap24hUsd} / ${alertsFired.mcapAtAlertUsd} end as x24h,
        case when ${alertsFired.athAt} is not null
             then extract(epoch from (${alertsFired.athAt} - ${alertsFired.createdAt})) / 60.0
             end as minutes_to_peak
      from ${alertsFired}
      where ${alertsFired.chain} = ${chain}
        and ${alertsFired.superseded} = false
        and ${alertsFired.outOfBand} = false
        and ${alertsFired.createdAt} > now() - make_interval(days => ${days})
    )
    select
      tier,
      count(*)::int as alerts,
      count(peak_x)::int as scored,
      count(*) filter (where peak_x >= 2)::int as hits_2x,
      count(*) filter (where peak_x >= 5)::int as hits_5x,
      count(*) filter (where peak_x >= 10)::int as hits_10x,
      percentile_cont(0.5) within group (
        order by case when peak_x >= 2 then peak_x end
      )::float8 as median_winner_peak_x,
      max(peak_x)::float8 as best_peak_x,
      -- Among winners only. Across every call this is dominated by the tokens
      -- that peaked in the first sample and then died, which is a fact about
      -- the sampling rate rather than about the tier.
      percentile_cont(0.5) within group (
        order by case when peak_x >= 2 then minutes_to_peak end
      )::float8 as median_minutes_to_peak_x,
      percentile_cont(0.5) within group (order by x24h)::float8 as median_24h_x,
      count(x24h)::int as scored_24h,
      -- The real elapsed span, floored at one day. Two reasons: a feed three
      -- days old must not be divided by thirty, and a feed forty minutes old
      -- must not be multiplied by thirty-six — that produced "4,082 calls/day"
      -- from 113 calls. Under a day these read as running totals, which is what
      -- they honestly are.
      greatest(
        extract(epoch from (now() - min(created_at))) / 86400.0,
        1.0
      )::float8 as span_days
    from scored
    group by tier
  `);

  const byTier = new Map(rows.map((r) => [Number(r.tier), r]));

  return ALERT_TIERS.map((t) => {
    const row = byTier.get(t.wallets);
    const alerts = Number(row?.alerts ?? 0);
    const hits2x = Number(row?.hits_2x ?? 0);
    const scored = Number(row?.scored ?? 0);
    const spanDays = Number(row?.span_days ?? 1) || 1;
    return {
      tier: t.wallets,
      windowSeconds: t.windowSeconds,
      label: t.label,
      kind: t.kind,
      alerts,
      scored,
      callsPerDay: alerts / spanDays,
      hits2x,
      hits5x: Number(row?.hits_5x ?? 0),
      hits10x: Number(row?.hits_10x ?? 0),
      hits2xPerDay: hits2x / spanDays,
      hitRate2x: scored > 0 ? hits2x / scored : null,
      medianWinnerPeakX: num(row?.median_winner_peak_x),
      bestPeakX: num(row?.best_peak_x),
      medianMinutesToPeakX: num(row?.median_minutes_to_peak_x),
      median24hX: num(row?.median_24h_x),
      scored24h: Number(row?.scored_24h ?? 0),
    };
  });
}

/**
 * The headline: how many calls, and how many were good.
 *
 * Grouped by call — `(token, episode)` — not by row. A token that escalates
 * 2 -> 3 -> 4 -> 5 -> 6 writes five rows, and summing the per-tier table would
 * count that one call five times. That is exactly what made the first version
 * report "5" ten-baggers from one token.
 *
 * Entry is the FIRST step's cap, because that is where the call was made. Peak
 * is shared across the call's rows, being a property of the token.
 */
export interface CallScore {
  calls: number;
  callsPerDay: number;
  scored: number;
  hits2x: number;
  hits5x: number;
  hits10x: number;
  hits2xPerDay: number;
  bestPeakX: number | null;
  medianWinnerPeakX: number | null;
  /**
   * What holding would actually have paid, at three fixed ages.
   *
   * Collected by the tracking cron since the scoreboard shipped and never once
   * read until now. They are the only figures here that answer "what would I
   * have made", because nobody sells the top: the peak is the ceiling, these are
   * the realistic middle. Over ALL scored calls, winners and zeros alike — that
   * is the whole point of them.
   *
   * Null until the feed is old enough. Each carries its own sample count so a
   * dash reads as "too early" rather than "no edge".
   */
  median1hX: number | null;
  median6hX: number | null;
  median24hX: number | null;
  scored1h: number;
  scored6h: number;
  scored24h: number;
  /** Median minutes from firing to peak, among winners. How long a reader had. */
  medianMinutesToPeakX: number | null;
  /** Median low, over entry, among winners — how rough the ride was on the calls
   * that worked. A 6x that first halved is not the same product as a 6x that
   * went straight up, and the difference is entirely who held. */
  medianWinnerDrawdownX: number | null;
}

export async function fetchCallScore(chain: string, days = 30): Promise<CallScore> {
  const empty: CallScore = {
    calls: 0,
    callsPerDay: 0,
    scored: 0,
    hits2x: 0,
    hits5x: 0,
    hits10x: 0,
    hits2xPerDay: 0,
    bestPeakX: null,
    medianWinnerPeakX: null,
    median1hX: null,
    median6hX: null,
    median24hX: null,
    scored1h: 0,
    scored6h: 0,
    scored24h: 0,
    medianMinutesToPeakX: null,
    medianWinnerDrawdownX: null,
  };
  const db = getDb();
  if (!db) return empty;

  const [row] = await db.execute<{
    calls: number;
    scored: number;
    hits_2x: number;
    hits_5x: number;
    hits_10x: number;
    best_peak_x: number | null;
    median_winner_peak_x: number | null;
    median_1h_x: number | null;
    median_6h_x: number | null;
    median_24h_x: number | null;
    scored_1h: number;
    scored_6h: number;
    scored_24h: number;
    median_minutes_to_peak_x: number | null;
    median_winner_drawdown_x: number | null;
    span_days: number | null;
  }>(sql`
    with calls as (
      select
        min(${alertsFired.createdAt}) as created_at,
        (array_agg(${alertsFired.mcapAtAlertUsd} order by ${alertsFired.tier} asc))[1] as entry,
        max(${alertsFired.athMcapUsd}) as peak,
        -- The earliest moment any step of this call recorded its running max.
        -- Every step of a call tracks the same token and is sampled in the same
        -- pass, so the peak is shared and this is when it was first seen.
        min(${alertsFired.athAt}) as peak_at,
        min(${alertsFired.lowMcapUsd}) as low,
        max(${alertsFired.mcap1hUsd}) as m1h,
        max(${alertsFired.mcap6hUsd}) as m6h,
        max(${alertsFired.mcap24hUsd}) as m24h
      from ${alertsFired}
      where ${alertsFired.chain} = ${chain}
        and ${alertsFired.superseded} = false
        and ${alertsFired.outOfBand} = false
        and ${alertsFired.createdAt} > now() - make_interval(days => ${days})
      group by ${alertsFired.tokenAddress}, ${alertsFired.episode}
    ),
    scored as (
      select
        created_at,
        case when entry >= ${MIN_SCOREBOARD_MCAP_USD} and peak is not null
             then peak / entry end as peak_x,
        case when entry >= ${MIN_SCOREBOARD_MCAP_USD} and low is not null
             then low / entry end as low_x,
        case when entry >= ${MIN_SCOREBOARD_MCAP_USD} and m1h is not null
             then m1h / entry end as x1h,
        case when entry >= ${MIN_SCOREBOARD_MCAP_USD} and m6h is not null
             then m6h / entry end as x6h,
        case when entry >= ${MIN_SCOREBOARD_MCAP_USD} and m24h is not null
             then m24h / entry end as x24h,
        case when peak_at is not null
             then extract(epoch from (peak_at - created_at)) / 60.0 end as minutes_to_peak
      from calls
    )
    select
      count(*)::int as calls,
      count(peak_x)::int as scored,
      count(*) filter (where peak_x >= 2)::int as hits_2x,
      count(*) filter (where peak_x >= 5)::int as hits_5x,
      count(*) filter (where peak_x >= 10)::int as hits_10x,
      max(peak_x)::float8 as best_peak_x,
      percentile_cont(0.5) within group (
        order by case when peak_x >= 2 then peak_x end
      )::float8 as median_winner_peak_x,
      percentile_cont(0.5) within group (order by x1h)::float8 as median_1h_x,
      percentile_cont(0.5) within group (order by x6h)::float8 as median_6h_x,
      percentile_cont(0.5) within group (order by x24h)::float8 as median_24h_x,
      count(x1h)::int as scored_1h,
      count(x6h)::int as scored_6h,
      count(x24h)::int as scored_24h,
      percentile_cont(0.5) within group (
        order by case when peak_x >= 2 then minutes_to_peak end
      )::float8 as median_minutes_to_peak_x,
      percentile_cont(0.5) within group (
        order by case when peak_x >= 2 then low_x end
      )::float8 as median_winner_drawdown_x,
      greatest(extract(epoch from (now() - min(created_at))) / 86400.0, 1.0)::float8 as span_days
    from scored
  `);

  const spanDays = Number(row?.span_days ?? 1) || 1;
  const calls = Number(row?.calls ?? 0);
  const hits2x = Number(row?.hits_2x ?? 0);
  return {
    calls,
    callsPerDay: calls / spanDays,
    scored: Number(row?.scored ?? 0),
    hits2x,
    hits5x: Number(row?.hits_5x ?? 0),
    hits10x: Number(row?.hits_10x ?? 0),
    hits2xPerDay: hits2x / spanDays,
    bestPeakX: num(row?.best_peak_x),
    medianWinnerPeakX: num(row?.median_winner_peak_x),
    median1hX: num(row?.median_1h_x),
    median6hX: num(row?.median_6h_x),
    median24hX: num(row?.median_24h_x),
    scored1h: Number(row?.scored_1h ?? 0),
    scored6h: Number(row?.scored_6h ?? 0),
    scored24h: Number(row?.scored_24h ?? 0),
    medianMinutesToPeakX: num(row?.median_minutes_to_peak_x),
    medianWinnerDrawdownX: num(row?.median_winner_drawdown_x),
  };
}

/**
 * Where the edge is, sliced by something other than the tier.
 *
 * The tier table answers "which escalation step is worth reading". It cannot
 * answer "does a call at $15K beat a call at $150K", or "does a tight
 * thirty-second burst beat an hour of accumulation" — and those are the levers
 * left once the tiers are set. Each cut is grouped by CALL, and every dimension
 * except the last is taken from the FIRST announced step, so it reads as what
 * was knowable at the moment the message went out rather than in hindsight.
 *
 * `rugRate` is here and the peak table has no equivalent on purpose. A cut can
 * be worth making because it removes losers rather than because it finds
 * winners, and that is invisible in a hit rate: on the first night, calls
 * posting with $1.5K+ of roster money already in had the same 2x rate as the
 * rest and rugged zero times out of eight.
 */
export interface AlertCut {
  /** Which slice this row belongs to, e.g. "Entry cap". */
  dimension: string;
  /** The bucket label, e.g. "$25-60K". */
  bucket: string;
  /** Display order within the dimension. */
  ord: number;
  calls: number;
  scored: number;
  hits2x: number;
  hitRate2x: number | null;
  medianWinnerPeakX: number | null;
  /** Share of scored calls that ended below half the entry cap. */
  rugRate: number | null;
  median24hX: number | null;
}

export async function fetchAlertCuts(chain: string, days = 30): Promise<AlertCut[]> {
  const db = getDb();
  if (!db) return [];

  const rows = await db.execute<{
    dimension: string;
    bucket: string;
    ord: number;
    calls: number;
    scored: number;
    hits_2x: number;
    median_winner_peak_x: number | null;
    rugs: number;
    median_24h_x: number | null;
  }>(sql`
    with calls as (
      select
        (array_agg(${alertsFired.mcapAtAlertUsd} order by ${alertsFired.tier} asc))[1] as entry,
        (array_agg(${alertsFired.totalBoughtUsd} order by ${alertsFired.tier} asc))[1] as bought,
        (array_agg(${alertsFired.spanSeconds} order by ${alertsFired.tier} asc))[1] as span_seconds,
        (array_agg(${alertsFired.exitedCount} order by ${alertsFired.tier} asc))[1] as exited,
        (array_agg(${alertsFired.walletCount} order by ${alertsFired.tier} asc))[1] as wallets,
        max(${alertsFired.tier}) as peak_tier,
        max(${alertsFired.athMcapUsd}) as peak,
        max(${alertsFired.mcap24hUsd}) as m24h
      from ${alertsFired}
      where ${alertsFired.chain} = ${chain}
        and ${alertsFired.superseded} = false
        and ${alertsFired.outOfBand} = false
        and ${alertsFired.createdAt} > now() - make_interval(days => ${days})
      group by ${alertsFired.tokenAddress}, ${alertsFired.episode}
    ),
    scored as (
      select
        entry, bought, span_seconds, exited, wallets, peak_tier,
        case when entry >= ${MIN_SCOREBOARD_MCAP_USD} and peak is not null
             then peak / entry end as peak_x,
        case when entry >= ${MIN_SCOREBOARD_MCAP_USD} and m24h is not null
             then m24h / entry end as x24h
      from calls
    ),
    -- One lateral VALUES row per dimension, so every cut comes out of a single
    -- pass over the calls. Four separate GROUP BY queries would be four round
    -- trips against a pool of three, and they must not be run concurrently.
    tagged as (
      select s.peak_x, s.x24h, d.dimension, d.bucket, d.ord
      from scored s
      cross join lateral (values
        (
          'Entry cap',
          (case when s.entry is null then null
                when s.entry < 25000 then '$10-25K'
                when s.entry < 60000 then '$25-60K'
                when s.entry < 200000 then '$60-200K'
                else '$200K+' end)::text,
          (case when s.entry is null then 0
                when s.entry < 25000 then 1
                when s.entry < 60000 then 2
                when s.entry < 200000 then 3
                else 4 end)::int
        ),
        (
          'Roster $ in at post',
          (case when s.bought is null then null
                when s.bought < 400 then 'under $400'
                when s.bought < 1000 then '$400-1K'
                when s.bought < 2500 then '$1-2.5K'
                else '$2.5K+' end)::text,
          (case when s.bought is null then 0
                when s.bought < 400 then 1
                when s.bought < 1000 then 2
                when s.bought < 2500 then 3
                else 4 end)::int
        ),
        (
          'Cluster span',
          (case when s.span_seconds is null then null
                when s.span_seconds < 30 then 'under 30s'
                when s.span_seconds < 120 then '30s-2m'
                when s.span_seconds < 600 then '2-10m'
                else '10m+' end)::text,
          (case when s.span_seconds is null then 0
                when s.span_seconds < 30 then 1
                when s.span_seconds < 120 then 2
                when s.span_seconds < 600 then 3
                else 4 end)::int
        ),
        (
          'Already sold at post',
          (case when s.wallets is null or s.wallets = 0 then null
                when s.exited = 0 then 'none out'
                when s.exited::float8 / s.wallets <= 0.33 then 'up to a third'
                when s.exited::float8 / s.wallets <= 0.6 then 'a third to 60%'
                else 'over 60%' end)::text,
          (case when s.wallets is null or s.wallets = 0 then 0
                when s.exited = 0 then 1
                when s.exited::float8 / s.wallets <= 0.33 then 2
                when s.exited::float8 / s.wallets <= 0.6 then 3
                else 4 end)::int
        ),
        (
          -- The one hindsight cut, and labelled as such in the UI. It is the
          -- strongest correlate in the data and an operator needs to see it,
          -- but it cannot be turned into a filter: nothing at post time says
          -- whether a 2-wallet call will go on to reach twenty.
          'Escalated to (hindsight)',
          (case when s.peak_tier is null then null
                when s.peak_tier <= 3 then '2-3 wallets'
                when s.peak_tier <= 6 then '4-6 wallets'
                when s.peak_tier <= 10 then '8-10 wallets'
                else '15-20 wallets' end)::text,
          (case when s.peak_tier is null then 0
                when s.peak_tier <= 3 then 1
                when s.peak_tier <= 6 then 2
                when s.peak_tier <= 10 then 3
                else 4 end)::int
        )
      ) as d(dimension, bucket, ord)
      where d.bucket is not null
    )
    select
      dimension,
      bucket,
      min(ord)::int as ord,
      count(*)::int as calls,
      count(peak_x)::int as scored,
      count(*) filter (where peak_x >= 2)::int as hits_2x,
      percentile_cont(0.5) within group (
        order by case when peak_x >= 2 then peak_x end
      )::float8 as median_winner_peak_x,
      count(*) filter (where peak_x < 0.5)::int as rugs,
      percentile_cont(0.5) within group (order by x24h)::float8 as median_24h_x
    from tagged
    group by dimension, bucket
    order by dimension, ord
  `);

  return rows.map((r) => {
    const scored = Number(r.scored ?? 0);
    return {
      dimension: r.dimension,
      bucket: r.bucket,
      ord: Number(r.ord ?? 0),
      calls: Number(r.calls ?? 0),
      scored,
      hits2x: Number(r.hits_2x ?? 0),
      hitRate2x: scored > 0 ? Number(r.hits_2x ?? 0) / scored : null,
      medianWinnerPeakX: num(r.median_winner_peak_x),
      rugRate: scored > 0 ? Number(r.rugs ?? 0) / scored : null,
      median24hX: num(r.median_24h_x),
    };
  });
}

/**
 * What every filter in the system took out of the channel, and how it did.
 *
 * The point is `bestPeakX`. AGENTS.md's rule for a volume knob is that a
 * suppressed call is still recorded, "because a suppressed call that turns out
 * to have been good is the only evidence the knob is wrong" — and until now
 * nothing displayed that evidence, so the rule was true and useless. If the
 * mostly-sold row ever shows an 8x, that threshold is costing money and this is
 * where it becomes visible.
 *
 * Counted in STEPS, not calls, because the unit a filter removes is a message.
 * `Superseded` is checked first: those steps were never going to post, being the
 * lower rungs claimed in the same instant as the tier actually announced.
 */
export interface SuppressionRow {
  reason: string;
  steps: number;
  scored: number;
  hits2x: number;
  bestPeakX: number | null;
}

export async function fetchAlertSuppression(
  chain: string,
  days = 30
): Promise<SuppressionRow[]> {
  const db = getDb();
  if (!db) return [];

  const rows = await db.execute<{
    reason: string;
    steps: number;
    scored: number;
    hits_2x: number;
    best_peak_x: number | null;
  }>(sql`
    with steps as (
      select
        case
          when ${alertsFired.superseded} then 'Superseded'
          when ${alertsFired.outOfBand} and ${alertsFired.mcapAtAlertUsd} < ${MIN_ALERT_MCAP_USD}
            then 'Under the band floor'
          when ${alertsFired.outOfBand} and ${alertsFired.mcapAtAlertUsd} > ${MAX_ALERT_MCAP_USD}
            then 'Over the band ceiling'
          when ${alertsFired.outOfBand} then 'Out of band'
          when ${alertsFired.deliveryError} like 'mostly-sold%' then 'Mostly sold'
          when ${alertsFired.deliveryError} like 'suppressed-below-tier%' then 'Under the min tier'
          when ${alertsFired.deliveryError} like 'suppressed-below-mcap%' then 'Under the min cap'
          when ${alertsFired.deliveryError} is not null then 'Delivery failed'
          else 'Posted'
        end as reason,
        -- Scored on the same footing as everything else, so a suppressed step
        -- and a posted one are directly comparable.
        case when ${alertsFired.mcapAtAlertUsd} >= ${MIN_SCOREBOARD_MCAP_USD}
              and ${alertsFired.athMcapUsd} is not null
             then ${alertsFired.athMcapUsd} / ${alertsFired.mcapAtAlertUsd} end as peak_x
      from ${alertsFired}
      where ${alertsFired.chain} = ${chain}
        and ${alertsFired.createdAt} > now() - make_interval(days => ${days})
    )
    select
      reason,
      count(*)::int as steps,
      count(peak_x)::int as scored,
      count(*) filter (where peak_x >= 2)::int as hits_2x,
      max(peak_x)::float8 as best_peak_x
    from steps
    group by reason
    order by count(*) desc
  `);

  return rows.map((r) => ({
    reason: r.reason,
    steps: Number(r.steps ?? 0),
    scored: Number(r.scored ?? 0),
    hits2x: Number(r.hits_2x ?? 0),
    bestPeakX: num(r.best_peak_x),
  }));
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
    where ${alertsFired.chain} = ${chain}
      and ${alertsFired.superseded} = false
      and ${alertsFired.outOfBand} = false
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

// --- The pinned leaderboard ---

/** One call on the pin: where it was called, where it peaked, and the multiple. */
export interface TopCall {
  tokenAddress: string;
  tokenSymbol: string | null;
  tokenName: string | null;
  /** Highest step announced on the call — what the pin credits it as. */
  peakTier: number;
  walletCount: number;
  /** From the FIRST step. Same rule as the feed: crediting ourselves with a
   * later escalation's entry after announcing at 2 wallets would be marking our
   * own homework. */
  entryMcapUsd: number;
  athMcapUsd: number;
  peakX: number;
  athAt: string | null;
  createdAt: string;
}

/**
 * The best calls of the last N hours, for the hourly pin.
 *
 * Grouped by `(token, episode)` — ONE call, however many steps it escalated
 * through. Reading the ungrouped rows here would put one token on the pin three
 * times, which is the same arithmetic trap that once reported a single
 * ten-bagger as five.
 *
 * `peak_x > 1` is a floor, not a ranking tweak: a pin is a leaderboard, and a
 * call that never traded above where it was called is not a top call at any
 * rank. Fewer than N qualifying calls shows fewer rows rather than padding the
 * list with flat ones.
 *
 * This is per-call performance — the same numbers the public feed already puts
 * on every row — and deliberately NOT the aggregate scoreboard. Hit rates and
 * hold medians stay on /admin: an operator's median read as a return somebody
 * made is a claim we cannot stand behind.
 */
export async function fetchTopCalls(
  chain: string,
  hours: number,
  limit: number
): Promise<TopCall[]> {
  const db = getDb();
  if (!db) return [];

  const rows = await db.execute<{
    token_address: string;
    token_symbol: string | null;
    token_name: string | null;
    peak_tier: number;
    wallet_count: number;
    entry_mcap_usd: number;
    ath_mcap_usd: number;
    peak_x: number;
    ath_at: string | null;
    created_at: string;
  }>(sql`
    with calls as (
      select
        ${alertsFired.tokenAddress} as token_address,
        (array_agg(${alertsFired.tokenSymbol} order by ${alertsFired.tier} desc))[1] as token_symbol,
        (array_agg(${alertsFired.tokenName} order by ${alertsFired.tier} desc))[1] as token_name,
        max(${alertsFired.tier})::int as peak_tier,
        (array_agg(${alertsFired.walletCount} order by ${alertsFired.tier} desc))[1]::int as wallet_count,
        (array_agg(${alertsFired.mcapAtAlertUsd} order by ${alertsFired.tier} asc))[1] as entry_mcap_usd,
        max(${alertsFired.athMcapUsd}) as ath_mcap_usd,
        max(${alertsFired.athAt}) as ath_at,
        min(${alertsFired.createdAt}) as created_at
      from ${alertsFired}
      where ${alertsFired.chain} = ${chain}
        and ${alertsFired.superseded} = false
        and ${alertsFired.outOfBand} = false
        and ${alertsFired.createdAt} > now() - make_interval(hours => ${Math.max(1, Math.round(hours))})
      group by ${alertsFired.chain}, ${alertsFired.tokenAddress}, ${alertsFired.episode}
      -- At least one step of the call actually reached the channel. A pin is
      -- read by the channel, so headlining a call that was suppressed on its
      -- way out would be crediting ourselves with a tip nobody was given.
      having count(${alertsFired.deliveredAt}) > 0
    )
    select
      token_address,
      token_symbol,
      token_name,
      peak_tier,
      wallet_count,
      entry_mcap_usd::float8 as entry_mcap_usd,
      ath_mcap_usd::float8 as ath_mcap_usd,
      (ath_mcap_usd / entry_mcap_usd)::float8 as peak_x,
      ath_at,
      created_at
    from calls
    where entry_mcap_usd >= ${PIN_MIN_MCAP_USD}
      and ath_mcap_usd is not null
      and ath_mcap_usd > entry_mcap_usd
    order by peak_x desc
    limit ${Math.max(1, Math.min(limit, 10))}
  `);

  return rows.map((r) => ({
    tokenAddress: r.token_address,
    tokenSymbol: r.token_symbol,
    tokenName: r.token_name,
    peakTier: Number(r.peak_tier),
    walletCount: Number(r.wallet_count),
    entryMcapUsd: Number(r.entry_mcap_usd),
    athMcapUsd: Number(r.ath_mcap_usd),
    peakX: Number(r.peak_x),
    athAt: r.ath_at ? new Date(r.ath_at).toISOString() : null,
    createdAt: new Date(r.created_at).toISOString(),
  }));
}

/** A pinned message we own, as last recorded. */
export interface PinnedMessage {
  chatId: string;
  messageId: number;
  postedAt: string;
  updatedAt: string;
}

export async function fetchPinnedMessage(kind: string): Promise<PinnedMessage | null> {
  const db = getDb();
  if (!db) return null;
  const [row] = await db
    .select({
      chatId: botMessages.chatId,
      messageId: botMessages.messageId,
      postedAt: botMessages.postedAt,
      updatedAt: botMessages.updatedAt,
    })
    .from(botMessages)
    .where(eq(botMessages.kind, kind))
    .limit(1);
  // A row with no id yet is a claim in flight, not a message to edit.
  if (!row || row.messageId === null) return null;
  return {
    chatId: row.chatId,
    messageId: Number(row.messageId),
    postedAt: row.postedAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Remember the message the cron will edit next hour.
 *
 * `postedAt` is only set on insert and is left alone by the update, so the gap
 * between it and `updatedAt` reads as "how long this pin has been live" — which
 * is how you tell an edit loop that is working from one that silently re-posts
 * every hour.
 */
export async function recordPinnedMessage(
  kind: string,
  chatId: string,
  messageId: number
): Promise<void> {
  const db = getDb();
  if (!db) return;
  await db
    .insert(botMessages)
    .values({ kind, chatId, messageId })
    .onConflictDoUpdate({
      target: botMessages.kind,
      set: { chatId, messageId, postedAt: sql`now()`, updatedAt: sql`now()` },
    });
}

/** Touch the timestamp after a successful in-place edit. */
export async function touchPinnedMessage(kind: string): Promise<void> {
  const db = getDb();
  if (!db) return;
  await db
    .update(botMessages)
    .set({ updatedAt: sql`now()` })
    .where(eq(botMessages.kind, kind));
}

/** Forget a pin whose message Telegram no longer has, so the next sweep posts
 * a fresh one instead of editing an id that will never resolve again. */
export async function clearPinnedMessage(kind: string): Promise<void> {
  const db = getDb();
  if (!db) return;
  await db.delete(botMessages).where(eq(botMessages.kind, kind));
}

/**
 * How many calls actually reached the channel in the same window.
 *
 * The denominator for the pin. "Top 3" on its own is a cherry-pick; "3 best of
 * 112" is the same three rows and an honest claim. Counted in CALLS, grouped by
 * `(token, episode)` — a token that escalated 2 -> 6 wrote five rows and is one
 * call, and inflating the denominator would understate ourselves as surely as
 * omitting it overstates.
 */
export async function countDeliveredCalls(chain: string, hours: number): Promise<number> {
  const db = getDb();
  if (!db) return 0;
  const [row] = await db.execute<{ calls: number }>(sql`
    select count(*)::int as calls
    from (
      select 1
      from ${alertsFired}
      where ${alertsFired.chain} = ${chain}
        and ${alertsFired.superseded} = false
        and ${alertsFired.outOfBand} = false
        and ${alertsFired.createdAt} > now() - make_interval(hours => ${Math.max(1, Math.round(hours))})
      group by ${alertsFired.tokenAddress}, ${alertsFired.episode}
      having count(${alertsFired.deliveredAt}) > 0
    ) calls
  `);
  return Number(row?.calls ?? 0);
}

/**
 * Claim the right to post today's recap, exactly once.
 *
 * Returns true for the caller that got there first and false for everybody
 * else. The key is the local calendar day, so the guarantee is "one recap per
 * day" no matter how many times the hourly cron fires or how many times Vercel
 * retries a delivery — and it is an INSERT that either takes the primary key or
 * does not, never a read followed by a write. The same rule as
 * `alerts_fired_key_idx`: two concurrent invocations both reading "not posted
 * yet" is exactly how a channel ends up with two recaps.
 *
 * The row is claimed before the message exists, which is why `message_id` is
 * nullable. `attachBotMessageId` fills it in afterwards.
 */
export async function claimBotMessage(kind: string, chatId: string): Promise<boolean> {
  const db = getDb();
  if (!db) return false;
  const claimed = await db
    .insert(botMessages)
    .values({ kind, chatId })
    .onConflictDoNothing({ target: botMessages.kind })
    .returning({ kind: botMessages.kind });
  return claimed.length > 0;
}

/** Record the id of a message posted under an existing claim. */
export async function attachBotMessageId(kind: string, messageId: number): Promise<void> {
  const db = getDb();
  if (!db) return;
  await db
    .update(botMessages)
    .set({ messageId, updatedAt: sql`now()` })
    .where(eq(botMessages.kind, kind));
}

/**
 * Release a claim whose send failed.
 *
 * Without this a Telegram outage at 2pm would burn the day's claim and the
 * recap would never be posted at all — the next hourly pass has to be able to
 * try again. Only ever called when no message was sent.
 */
export async function releaseBotMessage(kind: string): Promise<void> {
  const db = getDb();
  if (!db) return;
  await db
    .delete(botMessages)
    .where(and(eq(botMessages.kind, kind), isNull(botMessages.messageId)));
}
