-- Turns the quality bar from a write gate into a column.
--
-- Until now `wallet_tokens` only ever received rows that cleared 2x AND $1k, so
-- a wallet appearing five times had five wins and an UNKNOWN number of losses.
-- Win rate was therefore uncomputable and every wallet in the database looked
-- like a genius. Losing trades are now written too, flagged rather than dropped.
--
-- `qualified` defaults to false, which is deliberately the wrong answer for the
-- rows already stored: every existing row cleared the old gate, so the backfill
-- below sets them true. New rows are written with an explicit value either way.
ALTER TABLE "wallet_tokens" ADD COLUMN IF NOT EXISTS "qualified" boolean NOT NULL DEFAULT false;
--> statement-breakpoint
-- Which test a row failed, for classifying later without re-deriving it from
-- figures that may since have been overwritten by a rescan.
ALTER TABLE "wallet_tokens" ADD COLUMN IF NOT EXISTS "disqualified_reason" text;
--> statement-breakpoint
-- Every row that predates this migration passed the old write gate.
UPDATE "wallet_tokens" SET "qualified" = true WHERE "qualified" = false;
--> statement-breakpoint
-- Covers `count(*) filter (where qualified)` per wallet, which is what the
-- prior-wins badge and the win-rate figure both read.
CREATE INDEX IF NOT EXISTS "wallet_tokens_wallet_qualified_idx" ON "wallet_tokens" ("wallet_id", "qualified");
--> statement-breakpoint
-- Same change for the enrichment worker's table: it also dropped every position
-- that didn't clear the bar, so a wallet's GMGN history only ever showed wins.
ALTER TABLE "wallet_positions" ADD COLUMN IF NOT EXISTS "qualified" boolean NOT NULL DEFAULT false;
--> statement-breakpoint
ALTER TABLE "wallet_positions" ADD COLUMN IF NOT EXISTS "disqualified_reason" text;
--> statement-breakpoint
UPDATE "wallet_positions" SET "qualified" = true WHERE "qualified" = false;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "wallet_positions_wallet_qualified_idx" ON "wallet_positions" ("wallet_id", "qualified");
