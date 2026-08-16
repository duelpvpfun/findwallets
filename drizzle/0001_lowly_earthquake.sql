CREATE TABLE "scan_credits" (
	"id" serial PRIMARY KEY NOT NULL,
	"payment_id" text NOT NULL,
	"paylink_id" text,
	"tier" integer NOT NULL,
	"claim_token" text NOT NULL,
	"email" text,
	"payer_wallet" text,
	"consumed_at" timestamp with time zone,
	"consumed_chain" text,
	"consumed_token_address" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "scan_credits_payment_id_idx" ON "scan_credits" USING btree ("payment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "scan_credits_claim_token_idx" ON "scan_credits" USING btree ("claim_token");