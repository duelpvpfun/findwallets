-- Wallet-detail clicks were re-hitting the paid upstream API on every single
-- click, including repeat clicks on the same wallet and the same wallet being
-- looked up again by a different buyer scanning the same trending token.
CREATE TABLE IF NOT EXISTS "wallet_detail_cache" (
  "id" serial PRIMARY KEY NOT NULL,
  "chain" text NOT NULL,
  "token_address" text NOT NULL,
  "wallet_address" text NOT NULL,
  "payload" text NOT NULL,
  "fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "wallet_detail_cache_key_idx" ON "wallet_detail_cache" ("chain", "token_address", "wallet_address");
