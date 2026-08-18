-- A wallet's best trades on OTHER tokens, so a row in the table can carry proof
-- of a track record instead of a single lucky scan. Sourced from GMGN's free
-- OpenAPI (wallet_holdings), which unlike our paid upstreams returns a wallet's
-- whole position history in one call.
CREATE TABLE IF NOT EXISTS "wallet_positions" (
  "wallet_id" integer NOT NULL REFERENCES "wallets"("id"),
  "chain" text NOT NULL,
  "token_address" text NOT NULL,
  "symbol" text,
  "name" text,
  "realized_pnl_usd" double precision,
  "unrealized_pnl_usd" double precision,
  "total_pnl_usd" double precision,
  "bought_usd" double precision,
  "sold_usd" double precision,
  "multiple_x" double precision,
  "avg_cost_usd" double precision,
  "balance" double precision,
  "value_usd" double precision,
  "buy_tx_count" integer,
  "sell_tx_count" integer,
  "last_trade_ms" bigint,
  "fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "wallet_positions_pk" PRIMARY KEY ("wallet_id", "token_address")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "wallet_positions_total_pnl_idx" ON "wallet_positions" ("total_pnl_usd");
--> statement-breakpoint
-- Denormalised "[27X] $42.1K $WIF" strings, so the table and ticker can render
-- badges without joining and re-ranking positions on every request.
ALTER TABLE "wallets" ADD COLUMN IF NOT EXISTS "win_badges" text[] DEFAULT '{}' NOT NULL;
--> statement-breakpoint
ALTER TABLE "wallets" ADD COLUMN IF NOT EXISTS "enriched_at" timestamp with time zone;
--> statement-breakpoint
-- Nulls-first ordering is the worker's queue.
CREATE INDEX IF NOT EXISTS "wallets_enriched_at_idx" ON "wallets" ("enriched_at");
