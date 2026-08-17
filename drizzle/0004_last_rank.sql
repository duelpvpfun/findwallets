ALTER TABLE "wallet_tokens" ADD COLUMN IF NOT EXISTS "last_rank" integer;--> statement-breakpoint
-- Seed from best_rank so the first rescan after deploy compares against a real
-- prior value instead of logging an "observation" for every existing row.
UPDATE "wallet_tokens" SET "last_rank" = "best_rank" WHERE "last_rank" IS NULL;
