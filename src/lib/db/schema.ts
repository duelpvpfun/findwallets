import {
  bigint,
  boolean,
  doublePrecision,
  index,
  integer,
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
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    /** How many distinct scans this wallet has shown up in. */
    timesSeen: integer("times_seen").notNull().default(0),
  },
  (t) => [
    uniqueIndex("wallets_chain_address_idx").on(t.chain, t.address),
    index("wallets_lifetime_pnl_idx").on(t.lifetimePnlUsd),
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
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("scan_credits_payment_id_idx").on(t.paymentId),
    uniqueIndex("scan_credits_claim_token_idx").on(t.claimToken),
    index("scan_credits_claim_nonce_hash_idx").on(t.claimNonceHash),
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
