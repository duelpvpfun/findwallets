-- Dropping Helio: payments are now verified directly on-chain via Helius, so
-- the paylink concept goes away in favor of a plain payment method string,
-- and quoted-but-unpaid purchases get their own table.
ALTER TABLE "scan_credits" RENAME COLUMN "paylink_id" TO "method";
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "payment_intents" (
  "id" text PRIMARY KEY NOT NULL,
  "nonce_hash" text NOT NULL,
  "tier" integer NOT NULL,
  "method" text NOT NULL,
  "payer" text NOT NULL,
  "amount" bigint NOT NULL,
  "mint" text,
  "status" text DEFAULT 'pending' NOT NULL,
  "signature" text,
  "claim_token" text,
  "expires_at" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "payment_intents_nonce_hash_idx" ON "payment_intents" ("nonce_hash");
