-- Reverts 0017. The quality bar goes back to being a write gate.
--
-- `wallet_tokens` and `wallet_positions` are the alpha-wallet database: a curated
-- record of wallets that actually cleared 2x AND $1,000 on a trade. 0017 turned
-- the bar into a column so a win rate could be computed, which meant storing the
-- near-misses too. That is not what this table is for — it is a list of wallets
-- worth tracking, not a log of every wallet a scan returned.
--
-- What a paying customer sees is unaffected and always was: the scan response
-- carries every trader the upstream provider returned, ranked by realized PNL.
-- This gate has never touched the payload, only the archive.
--
-- Safe to run once 0017 has been applied. Order matters: the rows are deleted
-- using the column, then the column goes.

-- Rows written while 0017 was live that would not have passed the gate. Small
-- profits, break-evens and losses — none of them alpha wallets.
DELETE FROM "wallet_tokens" WHERE "qualified" = false;
--> statement-breakpoint
DELETE FROM "wallet_positions" WHERE "qualified" = false;
--> statement-breakpoint

DROP INDEX IF EXISTS "wallet_tokens_wallet_qualified_idx";
--> statement-breakpoint
ALTER TABLE "wallet_tokens" DROP COLUMN IF EXISTS "qualified";
--> statement-breakpoint
ALTER TABLE "wallet_tokens" DROP COLUMN IF EXISTS "disqualified_reason";
--> statement-breakpoint

DROP INDEX IF EXISTS "wallet_positions_wallet_qualified_idx";
--> statement-breakpoint
ALTER TABLE "wallet_positions" DROP COLUMN IF EXISTS "qualified";
--> statement-breakpoint
ALTER TABLE "wallet_positions" DROP COLUMN IF EXISTS "disqualified_reason";
