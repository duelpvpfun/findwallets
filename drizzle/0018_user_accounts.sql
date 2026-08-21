-- Wallet accounts, so a purchase survives a cleared browser.
--
-- Entitlement lived only in a localStorage claim token: a buyer who cleared
-- their browser, switched device or hit an error lost a paid credit permanently,
-- and the only recovery was DMing the owner. `scan_credits.payer_wallet` was
-- already populated on every confirmed payment, so the moment someone signs in
-- with the wallet they paid from, every past purchase attaches retroactively.
--
-- Nothing here is required to scan or to pay. The anonymous claim-token flow is
-- untouched and every unspent claim token still redeems.

CREATE TABLE IF NOT EXISTS "users" (
  "id" serial PRIMARY KEY NOT NULL,
  "wallet" text NOT NULL,
  "display_name" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "last_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "users_wallet_idx" ON "users" ("wallet");
--> statement-breakpoint

-- Single-use challenge for Sign-In With Solana. The signed message is rebuilt
-- server-side from `wallet` + `nonce`, so a client-supplied message body is
-- never what gets verified.
CREATE TABLE IF NOT EXISTS "auth_nonces" (
  "nonce" text PRIMARY KEY NOT NULL,
  "wallet" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "used_at" timestamp with time zone
);
--> statement-breakpoint
-- Supports the daily sweep of nonces older than 24h.
CREATE INDEX IF NOT EXISTS "auth_nonces_created_at_idx" ON "auth_nonces" ("created_at");
--> statement-breakpoint

-- Credits become an account balance. Nullable: an anonymous purchase has no
-- user until its payer signs in, and must keep working forever if they never do.
ALTER TABLE "scan_credits" ADD COLUMN IF NOT EXISTS "user_id" integer;
--> statement-breakpoint
-- Covers both the balance lookup and the "oldest unconsumed credit at or above
-- this tier" pick that reserves one.
CREATE INDEX IF NOT EXISTS "scan_credits_user_idx" ON "scan_credits" ("user_id", "consumed_at", "tier");
--> statement-breakpoint
-- Retroactive attachment on sign-in reads this.
CREATE INDEX IF NOT EXISTS "scan_credits_payer_wallet_idx" ON "scan_credits" ("payer_wallet");
--> statement-breakpoint

-- Multi-credit purchases. A signed-in buyer can pay once for several scans
-- instead of doing a wallet round-trip per scan; the quoted amount is
-- quantity x tier price and is still verified on-chain against the exact figure.
-- Bound at quote time rather than read from the cookie at confirm time, so the
-- credits land on the right account even if the session changed in between.
ALTER TABLE "payment_intents" ADD COLUMN IF NOT EXISTS "quantity" integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
ALTER TABLE "payment_intents" ADD COLUMN IF NOT EXISTS "user_id" integer;
--> statement-breakpoint

-- The 7-day receipt. Its own table, not a column on scan_credits: a payload of
-- a few hundred KB on the credits row would be dragged into every balance query.
CREATE TABLE IF NOT EXISTS "scan_results" (
  "id" serial PRIMARY KEY NOT NULL,
  "user_id" integer,
  "credit_id" integer,
  "chain" text NOT NULL,
  "token_address" text NOT NULL,
  "token_symbol" text,
  "trader_count" integer DEFAULT 0 NOT NULL,
  "requested_count" integer,
  -- The FULL scan payload, unfiltered. A receipt that returns only the wallets
  -- clearing the quality bar is not the thing the buyer paid for.
  "payload" jsonb NOT NULL,
  -- Kept indefinitely while pinned, so "my results vanished" is a support
  -- message nobody has to send.
  "pinned" boolean DEFAULT false NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "scan_results_user_created_idx" ON "scan_results" ("user_id", "created_at" DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "scan_results_credit_idx" ON "scan_results" ("credit_id");
--> statement-breakpoint
-- Covers the daily purge.
CREATE INDEX IF NOT EXISTS "scan_results_expires_at_idx" ON "scan_results" ("expires_at");
