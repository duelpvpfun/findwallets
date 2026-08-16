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

/** Append-only log: one row per (wallet, token, scan). Never updated. */
export const observations = pgTable(
  "observations",
  {
    id: serial("id").primaryKey(),
    walletId: integer("wallet_id")
      .notNull()
      .references(() => wallets.id),
    tokenId: integer("token_id")
      .notNull()
      .references(() => tokens.id),
    rank: integer("rank"),
    realizedPnlUsd: doublePrecision("realized_pnl_usd").notNull(),
    roiPercent: doublePrecision("roi_percent"),
    multipleX: doublePrecision("multiple_x"),
    avgBuyPriceUsd: doublePrecision("avg_buy_price_usd"),
    avgSellPriceUsd: doublePrecision("avg_sell_price_usd"),
    avgBuyMcapUsd: doublePrecision("avg_buy_mcap_usd"),
    avgSellMcapUsd: doublePrecision("avg_sell_mcap_usd"),
    investedUsd: doublePrecision("invested_usd"),
    proceedsUsd: doublePrecision("proceeds_usd"),
    /** "all_time" (Solana) or "90d" (BSC/Base) — governs whether lower rescans overwrite. */
    rankingWindow: text("ranking_window").notNull(),
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("observations_wallet_token_idx").on(t.walletId, t.tokenId)]
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
    realizedPnlUsd: doublePrecision("realized_pnl_usd").notNull(),
    roiPercent: doublePrecision("roi_percent"),
    multipleX: doublePrecision("multiple_x"),
    avgBuyPriceUsd: doublePrecision("avg_buy_price_usd"),
    avgSellPriceUsd: doublePrecision("avg_sell_price_usd"),
    avgBuyMcapUsd: doublePrecision("avg_buy_mcap_usd"),
    avgSellMcapUsd: doublePrecision("avg_sell_mcap_usd"),
    investedUsd: doublePrecision("invested_usd"),
    proceedsUsd: doublePrecision("proceeds_usd"),
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
