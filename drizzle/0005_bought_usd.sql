-- The column always stored gross USD bought (Solana Tracker's buy volume), never
-- a net cost basis. Name it for what it holds.
ALTER TABLE "wallet_tokens" RENAME COLUMN "invested_usd" TO "bought_usd";--> statement-breakpoint
-- `observations` was append-only and never read back: every query goes through
-- `wallet_tokens`, which carries the same figures upserted.
DROP TABLE IF EXISTS "observations";
