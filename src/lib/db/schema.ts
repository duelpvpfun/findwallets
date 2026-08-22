import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  boolean,
  date,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

export const tokens = pgTable(
  "tokens",
  {
    id: serial("id").primaryKey(),
    chain: text("chain").notNull(),
    address: text("address").notNull(),
    symbol: text("symbol"),
    name: text("name"),
    imageUrl: text("image_url"),
    /** Snapshot of the last scan's pricing, used to render cached previews and
     * the wallet ticker without re-hitting a paid upstream API. */
    priceUsd: doublePrecision("price_usd"),
    marketCapUsd: doublePrecision("market_cap_usd"),
    nativePriceUsd: doublePrecision("native_price_usd"),
    /** Authoritative supply for market-cap math, so wallet-detail never has to
     * trust an attacker-controlled query parameter. */
    estimatedSupply: doublePrecision("estimated_supply"),
    /** Hand-picked tokens offered as a free sample scan. */
    showcase: boolean("showcase").notNull().default(false),
    firstScannedAt: timestamp("first_scanned_at", { withTimezone: true }).notNull().defaultNow(),
    lastScannedAt: timestamp("last_scanned_at", { withTimezone: true }).notNull().defaultNow(),
    scanCount: integer("scan_count").notNull().default(0),
  },
  (t) => [uniqueIndex("tokens_chain_address_idx").on(t.chain, t.address)]
);

export const wallets = pgTable(
  "wallets",
  {
    id: serial("id").primaryKey(),
    chain: text("chain").notNull(),
    address: text("address").notNull(),
    identityName: text("identity_name"),
    twitter: text("twitter"),
    /** Provenance of `identityName` / `twitter`: "fomo" for a curated import,
     * null when the name came off a scan (or is unknown). A curated row is a
     * directory entry with no trades of its own yet, so `purge-noncompliant`
     * has to be able to tell it apart from a scan leftover. */
    identitySource: text("identity_source"),
    tags: text("tags").array().notNull().default([]),
    isBot: boolean("is_bot").notNull().default(false),
    /**
     * Ruled out by hand, and never allowed back on the alert roster.
     *
     * Distinct from `isBot`, which records what an upstream provider said.
     * This is a human decision, and it lives on the wallet rather than on
     * `alert_wallets` because the roster is REBUILT from `wallet_tokens` on
     * every sync — a wallet deactivated downstream walks straight back in
     * otherwise. See `drizzle/0029_blocked_wallets.sql`.
     */
    blocked: boolean("blocked").notNull().default(false),
    blockedReason: text("blocked_reason"),
    // Lifetime figures across ALL tokens — the guard against survivorship bias.
    // Null until the wallet gets enriched (Solana: always; BSC: top N only).
    lifetimePnlUsd: doublePrecision("lifetime_pnl_usd"),
    lifetimeWinRate: doublePrecision("lifetime_win_rate"),
    lifetimeTrades: integer("lifetime_trades"),
    lifetimeTokensTraded: integer("lifetime_tokens_traded"),
    lifetimeUpdatedAt: timestamp("lifetime_updated_at", { withTimezone: true }),
    /** Pre-rendered "[27X] $42.1K $WIF" strings from `walletPositions`. */
    winBadges: text("win_badges").array().notNull().default([]),
    enrichedAt: timestamp("enriched_at", { withTimezone: true }),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    /** How many distinct scans this wallet has shown up in. */
    timesSeen: integer("times_seen").notNull().default(0),
  },
  (t) => [
    uniqueIndex("wallets_chain_address_idx").on(t.chain, t.address),
    index("wallets_lifetime_pnl_idx").on(t.lifetimePnlUsd),
    index("wallets_enriched_at_idx").on(t.enrichedAt),
  ]
);

/**
 * A wallet's trades on tokens we never scanned, pulled from GMGN's free API.
 * `walletTokens` only knows about tokens someone paid to scan, so a wallet's
 * actual track record is invisible there — this table is what proves a top-50
 * placing wasn't a one-off.
 */
export const walletPositions = pgTable(
  "wallet_positions",
  {
    walletId: integer("wallet_id")
      .notNull()
      .references(() => wallets.id),
    chain: text("chain").notNull(),
    tokenAddress: text("token_address").notNull(),
    symbol: text("symbol"),
    name: text("name"),
    realizedPnlUsd: doublePrecision("realized_pnl_usd"),
    unrealizedPnlUsd: doublePrecision("unrealized_pnl_usd"),
    totalPnlUsd: doublePrecision("total_pnl_usd"),
    boughtUsd: doublePrecision("bought_usd"),
    soldUsd: doublePrecision("sold_usd"),
    multipleX: doublePrecision("multiple_x"),
    avgCostUsd: doublePrecision("avg_cost_usd"),
    balance: doublePrecision("balance"),
    valueUsd: doublePrecision("value_usd"),
    buyTxCount: integer("buy_tx_count"),
    sellTxCount: integer("sell_tx_count"),
    lastTradeMs: bigint("last_trade_ms", { mode: "number" }),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.walletId, t.tokenAddress] }),
    index("wallet_positions_total_pnl_idx").on(t.totalPnlUsd),
  ]
);

/** Current best-known truth per (wallet, token). Upserted; this is what you query. */
export const walletTokens = pgTable(
  "wallet_tokens",
  {
    walletId: integer("wallet_id")
      .notNull()
      .references(() => wallets.id),
    tokenId: integer("token_id")
      .notNull()
      .references(() => tokens.id),
    bestRank: integer("best_rank"),
    /** Rank on the most recent scan. `bestRank` is a running minimum, so only
     * this one can tell whether a rescan actually moved the wallet. */
    lastRank: integer("last_rank"),
    realizedPnlUsd: doublePrecision("realized_pnl_usd").notNull(),
    roiPercent: doublePrecision("roi_percent"),
    multipleX: doublePrecision("multiple_x"),
    avgBuyPriceUsd: doublePrecision("avg_buy_price_usd"),
    avgSellPriceUsd: doublePrecision("avg_sell_price_usd"),
    avgBuyMcapUsd: doublePrecision("avg_buy_mcap_usd"),
    avgSellMcapUsd: doublePrecision("avg_sell_mcap_usd"),
    /** Gross USD bought. Not a net cost basis — sale proceeds are `proceedsUsd`. */
    boughtUsd: doublePrecision("bought_usd"),
    proceedsUsd: doublePrecision("proceeds_usd"),
    /** Unsold position at scan time. Without these a wallet still holding its
     * bag reads as a loss, because only realized PNL is counted. */
    remainingPercent: doublePrecision("remaining_percent"),
    remainingValueUsd: doublePrecision("remaining_value_usd"),
    unrealizedPnlUsd: doublePrecision("unrealized_pnl_usd"),
    rankingWindow: text("ranking_window").notNull(),
    timesObserved: integer("times_observed").notNull().default(1),
    firstObservedAt: timestamp("first_observed_at", { withTimezone: true }).notNull().defaultNow(),
    lastObservedAt: timestamp("last_observed_at", { withTimezone: true }).notNull().defaultNow(),
    lastTradeMs: bigint("last_trade_ms", { mode: "number" }),
  },
  (t) => [
    primaryKey({ columns: [t.walletId, t.tokenId] }),
    index("wallet_tokens_pnl_idx").on(t.realizedPnlUsd),
    // Covers the per-wallet top-wins lateral join in fetchWalletHistories.
    index("wallet_tokens_wallet_pnl_idx").on(t.walletId, sql`${t.realizedPnlUsd} desc`),
  ]
);

/**
 * One row per completed on-chain payment, verified directly against Solana via
 * Helius. Written only by the server-side confirm route — never trusting a
 * browser-reported success — and consumed by exactly one scan.
 */
export const scanCredits = pgTable(
  "scan_credits",
  {
    id: serial("id").primaryKey(),
    /** The on-chain transaction signature; unique so a replayed confirm can't mint credits. */
    paymentId: text("payment_id").notNull(),
    /** How the buyer paid: "sol" or "usdc". */
    method: text("method"),
    /** Max wallets this credit unlocks (50/100/250/500). */
    tier: integer("tier").notNull(),
    /** Random token handed to the buyer; required to redeem. */
    claimToken: text("claim_token").notNull(),
    /** Browser-generated nonce tied to the payment intent. The claim token is
     * only released to a caller that presents it, so the public on-chain
     * transaction signature alone is not enough to steal someone's purchase. */
    claimNonceHash: text("claim_nonce_hash"),
    /** Set once the claim token has been handed to the browser. */
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    email: text("email"),
    payerWallet: text("payer_wallet"),
    /**
     * The account this credit belongs to, once one exists.
     *
     * Nullable on purpose and forever: an anonymous purchase has no user until
     * its payer signs in with the wallet they paid from, and a buyer who never
     * signs in must keep redeeming by claim token exactly as before.
     */
    userId: integer("user_id"),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    consumedChain: text("consumed_chain"),
    consumedTokenAddress: text("consumed_token_address"),
    /** Set alongside consumedAt and cleared once the scan is confirmed
     * delivered. A row still carrying this after the grace window means the
     * function died mid-scan, so the cron sweeper can hand the credit back. */
    reservedAt: timestamp("reserved_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("scan_credits_payment_id_idx").on(t.paymentId),
    uniqueIndex("scan_credits_claim_token_idx").on(t.claimToken),
    index("scan_credits_claim_nonce_hash_idx").on(t.claimNonceHash),
    index("scan_credits_reserved_at_idx").on(t.reservedAt),
    // Covers both the balance read and the "oldest unconsumed credit at or
    // above this tier" pick that reserves one.
    index("scan_credits_user_idx").on(t.userId, t.consumedAt, t.tier),
    // Retroactive attachment on sign-in reads this.
    index("scan_credits_payer_wallet_idx").on(t.payerWallet),
  ]
);

/** Every inbound payment confirmation attempt, accepted or not, so failures leave a trace. */
export const webhookLog = pgTable(
  "webhook_log",
  {
    id: serial("id").primaryKey(),
    outcome: text("outcome").notNull(),
    /** Only a short prefix — never a full secret. */
    authHeader: text("auth_header"),
    headerNames: text("header_names"),
    query: text("query"),
    body: text("body"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("webhook_log_created_at_idx").on(t.createdAt)]
);

/**
 * A quoted, not-yet-paid purchase: the exact lamports/USDC atomic amount and
 * unsigned transaction we offered the buyer, so the confirm step can verify
 * the transaction that actually landed matches what we quoted instead of
 * trusting a client-supplied amount.
 */
export const paymentIntents = pgTable(
  "payment_intents",
  {
    id: text("id").primaryKey(),
    /** Hash of the browser-generated nonce; required to confirm this intent. */
    nonceHash: text("nonce_hash").notNull(),
    tier: integer("tier").notNull(),
    /** "sol" or "usdc". */
    method: text("method").notNull(),
    /** Buyer's wallet public key (base58), fixed at quote time. */
    payer: text("payer").notNull(),
    /** Lamports (sol) or atomic USDC units (usdc). */
    amount: bigint("amount", { mode: "number" }).notNull(),
    /** Token mint for "usdc"; null for native SOL. */
    mint: text("mint"),
    /** How many credits this one payment buys. The quoted `amount` is already
     * multiplied by it, so on-chain verification is unchanged. */
    quantity: integer("quantity").notNull().default(1),
    /** Account the credits should land on, bound at quote time rather than read
     * from the cookie at confirm time — the session may have changed in between,
     * and multi-credit purchases would otherwise be orphaned. */
    userId: integer("user_id"),
    status: text("status").notNull().default("pending"),
    /** Filled in once a matching transaction is confirmed on-chain. */
    signature: text("signature"),
    claimToken: text("claim_token"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("payment_intents_nonce_hash_idx").on(t.nonceHash)]
);

/**
 * Caches the upstream wallet-detail response (Solana Tracker / Birdeye) per
 * (chain, token, wallet). Every row click re-fetching this from upstream is
 * what actually burns paid API credits, and the same wallet is frequently
 * re-clicked by the same buyer and re-fetched across completely different
 * buyers scanning the same trending token — this row is shared by all of them.
 */
export const walletDetailCache = pgTable(
  "wallet_detail_cache",
  {
    id: serial("id").primaryKey(),
    chain: text("chain").notNull(),
    tokenAddress: text("token_address").notNull(),
    walletAddress: text("wallet_address").notNull(),
    payload: text("payload").notNull(),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("wallet_detail_cache_key_idx").on(t.chain, t.tokenAddress, t.walletAddress),
  ]
);

/** One row per page view, for the owner dashboard only. */
export const siteVisits = pgTable(
  "site_visits",
  {
    id: serial("id").primaryKey(),
    path: text("path").notNull(),
    referrer: text("referrer"),
    country: text("country"),
    /** Salted digest of IP + user agent. The raw IP is never persisted. */
    visitorHash: text("visitor_hash").notNull(),
    userAgent: text("user_agent"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("site_visits_created_at_idx").on(t.createdAt),
    index("site_visits_visitor_idx").on(t.visitorHash),
    // Covers every dashboard panel: filter by window, count distinct visitors.
    index("site_visits_created_visitor_idx").on(t.createdAt, t.visitorHash),
  ]
);

/**
 * Paid upstream spend, rolled up per day + endpoint. Aggregated rather than one
 * row per request because a single 500-wallet scan fires ~50 Birdeye calls.
 */
export const apiUsage = pgTable(
  "api_usage",
  {
    id: serial("id").primaryKey(),
    day: date("day").notNull(),
    provider: text("provider").notNull(),
    endpoint: text("endpoint").notNull(),
    calls: integer("calls").notNull().default(0),
    /** Provider-specific units: Birdeye compute units, Solana Tracker requests. */
    credits: doublePrecision("credits").notNull().default(0),
    errors: integer("errors").notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("api_usage_day_endpoint_idx").on(t.day, t.provider, t.endpoint)]
);

/**
 * The admin dashboard's precomputed figures, refreshed by cron. A module-level
 * cache was per-lambda-instance, so every cold instance re-ran the whole
 * aggregate set; a single row means the dashboard costs one indexed read.
 */
export const statsSnapshot = pgTable("stats_snapshot", {
  /** Always 1 — this table holds exactly one row. */
  id: integer("id").primaryKey(),
  payload: jsonb("payload").notNull(),
  generatedAt: timestamp("generated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * A wallet account. Created the first time someone proves ownership of a Solana
 * address by signing a message — never by paying, and never required to pay.
 *
 * The address is the identity: there is no password, no email, and nothing to
 * reset. Signing in costs zero lamports (a signature, not a transaction).
 */
export const users = pgTable(
  "users",
  {
    id: serial("id").primaryKey(),
    /** Base58 Solana public key, exactly as the wallet reports it. */
    wallet: text("wallet").notNull(),
    displayName: text("display_name"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("users_wallet_idx").on(t.wallet)]
);

/**
 * One-shot sign-in challenge. The message the user signs is REBUILT server-side
 * from `wallet` + `nonce` at verify time, so the signature is never checked
 * against a message body the client supplied — otherwise a caller could sign
 * anything and present it as a sign-in.
 */
export const authNonces = pgTable(
  "auth_nonces",
  {
    nonce: text("nonce").primaryKey(),
    wallet: text("wallet").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    /** Set by the same atomic UPDATE that claims it, so a replay finds it used. */
    usedAt: timestamp("used_at", { withTimezone: true }),
  },
  (t) => [index("auth_nonces_created_at_idx").on(t.createdAt)]
);

/**
 * A paid scan's full result, kept for 7 days so a buyer can re-download it
 * without re-running (and re-paying for) the scan.
 *
 * Its own table rather than a column on `scanCredits`: a payload of a few hundred
 * KB sitting on the credits row would be pulled into every balance query.
 * Measured cost is ~930 bytes per trader — see `src/lib/db/scanResults.ts`.
 */
export const scanResults = pgTable(
  "scan_results",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id"),
    /** The purchase this result was delivered for; null for owner/free scans. */
    creditId: integer("credit_id"),
    chain: text("chain").notNull(),
    tokenAddress: text("token_address").notNull(),
    tokenSymbol: text("token_symbol"),
    traderCount: integer("trader_count").notNull().default(0),
    requestedCount: integer("requested_count"),
    /** The COMPLETE payload, unfiltered. A receipt that hands back only the
     * wallets clearing the quality bar is not what the buyer paid for. */
    payload: jsonb("payload").notNull(),
    /** Pinned results ignore `expiresAt` — the purge skips them. */
    pinned: boolean("pinned").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    index("scan_results_user_created_idx").on(t.userId, sql`${t.createdAt} desc`),
    index("scan_results_credit_idx").on(t.creditId),
    index("scan_results_expires_at_idx").on(t.expiresAt),
  ]
);

/**
 * The wallets whose on-chain buys we stream. A denormalised roster rather than a
 * view over `walletTokens`: the alert message quotes each wallet's track record,
 * and the hot path is a Helius webhook arriving several times a second on a
 * Postgres pool of 3. One indexed read per POST, no joins.
 *
 * Membership is recomputed by `scripts/sync-alert-wallets.mjs`, which is also
 * what pushes the address list to Helius. Rows are deactivated, never deleted,
 * so an alert fired last week still resolves the wallets that were in it.
 */
export const alertWallets = pgTable(
  "alert_wallets",
  {
    id: serial("id").primaryKey(),
    chain: text("chain").notNull(),
    address: text("address").notNull(),
    walletId: integer("wallet_id")
      .notNull()
      .references(() => wallets.id),
    label: text("label"),
    twitter: text("twitter"),
    tokenCount: integer("token_count").notNull().default(0),
    avgMultipleX: doublePrecision("avg_multiple_x"),
    avgPnlUsd: doublePrecision("avg_pnl_usd"),
    bestMultipleX: doublePrecision("best_multiple_x"),
    bestPnlUsd: doublePrecision("best_pnl_usd"),
    bestSymbol: text("best_symbol"),
    active: boolean("active").notNull().default(true),
    syncedAt: timestamp("synced_at", { withTimezone: true }),
    addedAt: timestamp("added_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("alert_wallets_chain_address_idx").on(t.chain, t.address),
    index("alert_wallets_active_idx").on(t.chain, t.active),
  ]
);

/**
 * A classified swap by a rostered wallet. Short-lived — the retention sweep in
 * the hourly cron drops anything older than `EVENT_RETENTION_HOURS`, because
 * this is a rolling window, not an archive.
 *
 * Sells are stored alongside buys and never trigger anything. They exist so an
 * alert can say a wallet had already exited by the time it fired.
 */
export const walletEvents = pgTable(
  "wallet_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    chain: text("chain").notNull(),
    txSignature: text("tx_signature").notNull(),
    walletAddress: text("wallet_address").notNull(),
    tokenAddress: text("token_address").notNull(),
    side: text("side").notNull(),
    amountUsd: doublePrecision("amount_usd").notNull().default(0),
    tokenAmount: doublePrecision("token_amount"),
    priceUsd: doublePrecision("price_usd"),
    blockTime: timestamp("block_time", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Helius retries any non-2xx delivery, and one transaction reaches us once
    // per tracked wallet in it. Both are no-ops because of this index.
    uniqueIndex("wallet_events_dedupe_idx").on(
      t.chain,
      t.txSignature,
      t.walletAddress,
      t.tokenAddress,
      t.side
    ),
    index("wallet_events_window_idx").on(t.chain, t.tokenAddress, t.side, sql`${t.blockTime} desc`),
    index("wallet_events_block_time_idx").on(t.blockTime),
  ]
);

/**
 * Per-token escalation state. `episode` increments once a token has been quiet
 * for longer than the configured gap, which is what re-arms it: without it, a
 * token that escalated 2 -> 3 -> 4 last Tuesday could never alert again.
 */
export const alertState = pgTable(
  "alert_state",
  {
    chain: text("chain").notNull(),
    tokenAddress: text("token_address").notNull(),
    episode: integer("episode").notNull().default(1),
    lastEventAt: timestamp("last_event_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.chain, t.tokenAddress] })]
);

/** One wallet as it stood when an alert fired. Frozen — a later roster resync
 * must not be able to rewrite what an alert claimed at the time. */
export interface AlertWalletSnapshot {
  address: string;
  label: string | null;
  twitter: string | null;
  /** Mean multiple across this wallet's recorded wins. */
  multipleX: number | null;
  /** Mean realized PNL across those wins. */
  pnlUsd: number | null;
  bestMultipleX: number | null;
  bestSymbol: string | null;
  /** What it put in on THIS token, in the window. */
  boughtUsd: number;
  boughtAt: string;
  /** Sold at least part of it before the alert fired. Still counted. */
  exited: boolean;
}

/** One hourly market-cap sample: `[unixSeconds, mcapUsd]`. */
export type AlertMcapSample = [number, number];

/**
 * An announced alert, and how the token did afterwards.
 *
 * The market-cap columns are the product's own scoreboard: every alert pins the
 * cap it fired at, the hourly cron keeps the running maximum, and the ratio of
 * the two is how a tier proves it is worth reading. Supply is pinned too, so a
 * later sample is price x the same supply and a supply change cannot show up as
 * a market-cap move.
 */
export const alertsFired = pgTable(
  "alerts_fired",
  {
    id: serial("id").primaryKey(),
    chain: text("chain").notNull(),
    tokenAddress: text("token_address").notNull(),
    tokenSymbol: text("token_symbol"),
    tokenName: text("token_name"),
    tokenImageUrl: text("token_image_url"),
    tier: integer("tier").notNull(),
    episode: integer("episode").notNull(),
    windowSeconds: integer("window_seconds").notNull(),
    /** Real first-to-last buy span. The message quotes this, not the configured
     * window, because "in the past 2 minutes" has to be true. */
    spanSeconds: integer("span_seconds").notNull().default(0),
    walletCount: integer("wallet_count").notNull(),
    wallets: jsonb("wallets").$type<AlertWalletSnapshot[]>().notNull().default([]),
    exitedCount: integer("exited_count").notNull().default(0),
    avgMultipleX: doublePrecision("avg_multiple_x"),
    avgPnlUsd: doublePrecision("avg_pnl_usd"),
    totalBoughtUsd: doublePrecision("total_bought_usd"),
    priceAtAlertUsd: doublePrecision("price_at_alert_usd"),
    mcapAtAlertUsd: doublePrecision("mcap_at_alert_usd"),
    supplyAtAlert: doublePrecision("supply_at_alert"),
    athMcapUsd: doublePrecision("ath_mcap_usd"),
    athAt: timestamp("ath_at", { withTimezone: true }),
    /** Running MINIMUM. Without it `ath / entry` is >= 1 by construction and the
     * scoreboard cannot express a losing call. See 0024_alert_drawdown.sql. */
    lowMcapUsd: doublePrecision("low_mcap_usd"),
    lowAt: timestamp("low_at", { withTimezone: true }),
    /** Cap at fixed ages, snapshotted once each. The only figures that answer
     * "what would I actually have made holding this" — nobody sells the top. */
    mcap1hUsd: doublePrecision("mcap_1h_usd"),
    mcap6hUsd: doublePrecision("mcap_6h_usd"),
    mcap24hUsd: doublePrecision("mcap_24h_usd"),
    lastMcapUsd: doublePrecision("last_mcap_usd"),
    samples: jsonb("samples").$type<AlertMcapSample[]>().notNull().default([]),
    trackedUntil: timestamp("tracked_until", { withTimezone: true }).notNull(),
    lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }),
    /** When the candle-based peak was last reconciled. Drives a rotation, not a
     * schedule: a candle high cannot be missed by looking late, so the only job
     * of the cadence is display freshness within a free rate limit. */
    athCheckedAt: timestamp("ath_checked_at", { withTimezone: true }),
    /** A lower tier claimed in the same instant as the one actually announced,
     * so it can never fire later on a smaller count. Excluded from the feed and
     * from every performance figure. */
    superseded: boolean("superseded").notNull().default(false),
    /** Claimed while the token's market cap was outside the alerting band.
     * Claimed so it can never fire later on the same count, but not announced
     * and not part of the record — see `drizzle/0025_alert_band.sql`. */
    outOfBand: boolean("out_of_band").notNull().default(false),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    deliveryError: text("delivery_error"),
    /** Set on the first announced step of a call, so later escalations on the
     * same token and episode reply to it rather than arriving as unrelated
     * posts. See `drizzle/0023_alert_calls.sql`. */
    telegramMessageId: bigint("telegram_message_id", { mode: "number" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("alerts_fired_key_idx").on(t.chain, t.tokenAddress, t.tier, t.episode),
    index("alerts_fired_created_idx").on(sql`${t.createdAt} desc`),
    index("alerts_fired_tracking_idx").on(t.trackedUntil, t.lastCheckedAt),
  ]
);

/**
 * A Telegram message the bot addresses by key instead of posting and forgetting.
 *
 * Two kinds live here, and `kind` is the whole difference:
 *
 *  - `leaderboard` — posted once, pinned, then EDITED in place every hour. One
 *    row, forever. 24 leaderboard posts a day would bury the alerts the pin
 *    exists to advertise, and only one message can usefully be pinned anyway.
 *  - `digest-YYYY-MM-DD` — the daily 2pm recap, one row per day. The row is
 *    claimed before the message is sent, so `messageId` is null for a moment
 *    and the primary key is what stops a retried cron delivery posting a second
 *    recap. That is the same rule as everywhere else in the alert path:
 *    idempotency is an index, never a read-then-write.
 *
 * `chatId` is part of the row, not assumed: a message id is meaningless outside
 * the chat it was posted in, so repointing `TELEGRAM_ALERT_CHAT_ID` has to make
 * the cron post a new message instead of editing an id that now belongs to
 * somebody else's channel.
 */
export const botMessages = pgTable("bot_messages", {
  kind: text("kind").primaryKey(),
  chatId: text("chat_id").notNull(),
  /** Null only between claiming a row and the send returning. */
  messageId: bigint("message_id", { mode: "number" }),
  postedAt: timestamp("posted_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * The pool a token trades in, cached.
 *
 * GeckoTerminal's OHLCV endpoint is keyed by pool, not by mint, so reading
 * candles costs a lookup first. The pool does not change, so paying it once per
 * token instead of once per read halves the cost of every peak check — and on a
 * ~30-call-a-minute free tier, halving the cost doubles the rotation.
 */
export const tokenPools = pgTable(
  "token_pools",
  {
    chain: text("chain").notNull(),
    tokenAddress: text("token_address").notNull(),
    poolAddress: text("pool_address").notNull(),
    /** Which provider resolved it, so a stale pool can be re-resolved without
     * guessing who wrote it. */
    source: text("source").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.chain, t.tokenAddress] })]
);
