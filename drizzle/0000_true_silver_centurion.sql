CREATE TABLE "observations" (
	"id" serial PRIMARY KEY NOT NULL,
	"wallet_id" integer NOT NULL,
	"token_id" integer NOT NULL,
	"rank" integer,
	"realized_pnl_usd" double precision NOT NULL,
	"roi_percent" double precision,
	"multiple_x" double precision,
	"avg_buy_price_usd" double precision,
	"avg_sell_price_usd" double precision,
	"avg_buy_mcap_usd" double precision,
	"avg_sell_mcap_usd" double precision,
	"invested_usd" double precision,
	"proceeds_usd" double precision,
	"ranking_window" text NOT NULL,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tokens" (
	"id" serial PRIMARY KEY NOT NULL,
	"chain" text NOT NULL,
	"address" text NOT NULL,
	"symbol" text,
	"name" text,
	"image_url" text,
	"first_scanned_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_scanned_at" timestamp with time zone DEFAULT now() NOT NULL,
	"scan_count" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wallet_tokens" (
	"wallet_id" integer NOT NULL,
	"token_id" integer NOT NULL,
	"best_rank" integer,
	"realized_pnl_usd" double precision NOT NULL,
	"roi_percent" double precision,
	"multiple_x" double precision,
	"avg_buy_price_usd" double precision,
	"avg_sell_price_usd" double precision,
	"avg_buy_mcap_usd" double precision,
	"avg_sell_mcap_usd" double precision,
	"invested_usd" double precision,
	"proceeds_usd" double precision,
	"ranking_window" text NOT NULL,
	"times_observed" integer DEFAULT 1 NOT NULL,
	"first_observed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_observed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_trade_ms" bigint,
	CONSTRAINT "wallet_tokens_wallet_id_token_id_pk" PRIMARY KEY("wallet_id","token_id")
);
--> statement-breakpoint
CREATE TABLE "wallets" (
	"id" serial PRIMARY KEY NOT NULL,
	"chain" text NOT NULL,
	"address" text NOT NULL,
	"identity_name" text,
	"twitter" text,
	"tags" text[] DEFAULT '{}' NOT NULL,
	"is_bot" boolean DEFAULT false NOT NULL,
	"lifetime_pnl_usd" double precision,
	"lifetime_win_rate" double precision,
	"lifetime_trades" integer,
	"lifetime_tokens_traded" integer,
	"lifetime_updated_at" timestamp with time zone,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"times_seen" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "observations" ADD CONSTRAINT "observations_wallet_id_wallets_id_fk" FOREIGN KEY ("wallet_id") REFERENCES "public"."wallets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "observations" ADD CONSTRAINT "observations_token_id_tokens_id_fk" FOREIGN KEY ("token_id") REFERENCES "public"."tokens"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_tokens" ADD CONSTRAINT "wallet_tokens_wallet_id_wallets_id_fk" FOREIGN KEY ("wallet_id") REFERENCES "public"."wallets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_tokens" ADD CONSTRAINT "wallet_tokens_token_id_tokens_id_fk" FOREIGN KEY ("token_id") REFERENCES "public"."tokens"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "observations_wallet_token_idx" ON "observations" USING btree ("wallet_id","token_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tokens_chain_address_idx" ON "tokens" USING btree ("chain","address");--> statement-breakpoint
CREATE INDEX "wallet_tokens_pnl_idx" ON "wallet_tokens" USING btree ("realized_pnl_usd");--> statement-breakpoint
CREATE UNIQUE INDEX "wallets_chain_address_idx" ON "wallets" USING btree ("chain","address");--> statement-breakpoint
CREATE INDEX "wallets_lifetime_pnl_idx" ON "wallets" USING btree ("lifetime_pnl_usd");