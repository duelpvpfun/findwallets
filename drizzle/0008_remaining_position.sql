ALTER TABLE "wallet_tokens" ADD COLUMN IF NOT EXISTS "remaining_percent" double precision;
--> statement-breakpoint
ALTER TABLE "wallet_tokens" ADD COLUMN IF NOT EXISTS "remaining_value_usd" double precision;
--> statement-breakpoint
ALTER TABLE "wallet_tokens" ADD COLUMN IF NOT EXISTS "unrealized_pnl_usd" double precision;
