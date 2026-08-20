import { sql } from "drizzle-orm";
import {
  bigint,
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
    tags: text("tags").array().notNull().default([]),
    isBot: boolean("is_bot").notNull().default(false),
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
    /** Whether this position clears the quality bar. Losing and marginal
     * positions are stored too — without them a wallet's GMGN history is all
     * wins and its win rate is uncomputable. */
    qualified: boolean("qualified").notNull().default(false),
    /** Which test it failed; null when `qualified`. */
    disqualifiedReason: text("disqualified_reason"),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.walletId, t.tokenAddress] }),
    index("wallet_positions_total_pnl_idx").on(t.totalPnlUsd),
    index("wallet_positions_wallet_qualified_idx").on(t.walletId, t.qualified),
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
    /**
     * Whether this trade cleared `meetsQualityBar` on the last scan that saw it.
     *
     * This used to be a write gate: rows that failed were never inserted, so the
     * table held only wins and a wallet's loss count was unknowable. Storing the
     * verdict instead is what makes `qualified / total` a real win rate.
     */
    qualified: boolean("qualified").notNull().default(false),
    /** Which test it failed; null when `qualified`. See `DisqualifiedReason`. */
    disqualifiedReason: text("disqualified_reason"),
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
    // Covers the per-wallet qualified/total counts behind the win-rate figure.
    index("wallet_tokens_wallet_qualified_idx").on(t.walletId, t.qualified),
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
