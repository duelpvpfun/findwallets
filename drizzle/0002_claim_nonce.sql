ALTER TABLE "scan_credits" ADD COLUMN "claim_nonce_hash" text;--> statement-breakpoint
ALTER TABLE "scan_credits" ADD COLUMN "claimed_at" timestamp with time zone;
