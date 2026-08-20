CREATE TABLE IF NOT EXISTS "stats_snapshot" (
	"id" integer PRIMARY KEY NOT NULL,
	"payload" jsonb NOT NULL,
	"generated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "wallet_tokens_wallet_pnl_idx" ON "wallet_tokens" USING btree ("wallet_id","realized_pnl_usd" DESC);
