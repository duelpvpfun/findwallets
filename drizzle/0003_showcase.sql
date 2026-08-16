ALTER TABLE "tokens" ADD COLUMN "native_price_usd" double precision;--> statement-breakpoint
ALTER TABLE "tokens" ADD COLUMN "price_usd" double precision;--> statement-breakpoint
ALTER TABLE "tokens" ADD COLUMN "market_cap_usd" double precision;--> statement-breakpoint
ALTER TABLE "tokens" ADD COLUMN "showcase" boolean DEFAULT false NOT NULL;
