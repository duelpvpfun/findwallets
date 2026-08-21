-- Real-time smart-money alerts.
--
-- Five tables. The reason there are five rather than one is that each solves a
-- different failure mode, and three of them exist purely to make the hot path
-- (a Helius webhook POST, arriving several times a second) survivable on a
-- Postgres pool of 3:
--
--   alert_wallets  — the roster, denormalised. The alert message quotes each
--                    wallet's track record, and recomputing that from
--                    wallet_tokens on every event would be a join per POST.
--   wallet_events  — classified buys and sells. Helius retries on any non-2xx,
--                    so the unique index is what makes a retry a no-op.
--   alert_state    — per-token episode counter. Escalation fires 2 -> 3 -> 4
--                    once each; without an episode a token could only ever
--                    alert once in its life.
--   alerts_fired   — what was announced, and the market-cap performance of it.
--   (tokens)       — reused, not duplicated. Symbol/image/supply already live there.

CREATE TABLE IF NOT EXISTS "alert_wallets" (
  "id" serial PRIMARY KEY,
  "chain" text NOT NULL,
  "address" text NOT NULL,
  "wallet_id" integer NOT NULL REFERENCES "wallets"("id"),
  "label" text,
  "twitter" text,
  -- Track record, frozen at sync time. Recomputed by scripts/sync-alert-wallets.mjs.
  "token_count" integer NOT NULL DEFAULT 0,
  "avg_multiple_x" double precision,
  "avg_pnl_usd" double precision,
  "best_multiple_x" double precision,
  "best_pnl_usd" double precision,
  "best_symbol" text,
  -- False takes a wallet off the roster without losing its history or its
  -- place in already-fired alerts.
  "active" boolean NOT NULL DEFAULT true,
  "synced_at" timestamptz,
  "added_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "alert_wallets_chain_address_idx" ON "alert_wallets" ("chain", "address");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "alert_wallets_active_idx" ON "alert_wallets" ("chain", "active");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "wallet_events" (
  "id" bigserial PRIMARY KEY,
  "chain" text NOT NULL,
  "tx_signature" text NOT NULL,
  "wallet_address" text NOT NULL,
  "token_address" text NOT NULL,
  -- 'buy' | 'sell'. Sells are recorded but never trigger an alert: they are
  -- what lets an alert say a wallet had already exited before it fired.
  "side" text NOT NULL,
  "amount_usd" double precision NOT NULL DEFAULT 0,
  "token_amount" double precision,
  "price_usd" double precision,
  "block_time" timestamptz NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
-- Idempotency. Helius retries a failed delivery, and one transaction can also
-- arrive twice when two tracked wallets are in it.
CREATE UNIQUE INDEX IF NOT EXISTS "wallet_events_dedupe_idx"
  ON "wallet_events" ("chain", "tx_signature", "wallet_address", "token_address", "side");
--> statement-breakpoint
-- The rolling-window count: distinct wallets for one token, one side, since T.
CREATE INDEX IF NOT EXISTS "wallet_events_window_idx"
  ON "wallet_events" ("chain", "token_address", "side", "block_time" DESC);
--> statement-breakpoint
-- Retention sweep.
CREATE INDEX IF NOT EXISTS "wallet_events_block_time_idx" ON "wallet_events" ("block_time");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "alert_state" (
  "chain" text NOT NULL,
  "token_address" text NOT NULL,
  -- Bumped when a token goes quiet for longer than the episode gap. Part of the
  -- alerts_fired unique key, so a token that accumulates again tomorrow can
  -- escalate from 2 again instead of being permanently spent.
  "episode" integer NOT NULL DEFAULT 1,
  "last_event_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("chain", "token_address")
);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "alerts_fired" (
  "id" serial PRIMARY KEY,
  "chain" text NOT NULL,
  "token_address" text NOT NULL,
  "token_symbol" text,
  "token_name" text,
  "token_image_url" text,
  -- Distinct-wallet count of the tier, e.g. 3. With `episode` and the token,
  -- this is what makes each escalation step fire exactly once.
  "tier" integer NOT NULL,
  "episode" integer NOT NULL,
  -- The tier's configured window, and the REAL span between the first and last
  -- buy. "in the past 2 minutes" has to be true, so the message quotes the span.
  "window_seconds" integer NOT NULL,
  "span_seconds" integer NOT NULL DEFAULT 0,
  "wallet_count" integer NOT NULL,
  -- Snapshot of who was in and what their record was, so a later roster resync
  -- cannot rewrite history.
  "wallets" jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- How many of those wallets had already sold before the alert fired. They
  -- still count toward the tier; the buyer deserves to know anyway.
  "exited_count" integer NOT NULL DEFAULT 0,
  "avg_multiple_x" double precision,
  "avg_pnl_usd" double precision,
  "total_bought_usd" double precision,
  -- Performance tracking. Supply is pinned at alert time so every later sample
  -- is price x the same supply — otherwise a supply change would masquerade as
  -- a market-cap move.
  "price_at_alert_usd" double precision,
  "mcap_at_alert_usd" double precision,
  "supply_at_alert" double precision,
  "ath_mcap_usd" double precision,
  "ath_at" timestamptz,
  "last_mcap_usd" double precision,
  -- Hourly [unix_seconds, mcap_usd] pairs, capped. A column rather than a table
  -- so drawing the sparkline costs no join.
  "samples" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "tracked_until" timestamptz NOT NULL,
  "last_checked_at" timestamptz,
  -- A lower tier claimed at the same instant as the tier actually announced.
  -- Recorded so it can never fire later on a smaller count; excluded from the
  -- feed and from every performance figure.
  "superseded" boolean NOT NULL DEFAULT false,
  "delivered_at" timestamptz,
  "delivery_error" text,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "alerts_fired_key_idx"
  ON "alerts_fired" ("chain", "token_address", "tier", "episode");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "alerts_fired_created_idx" ON "alerts_fired" ("created_at" DESC);
--> statement-breakpoint
-- The hourly tracker's work queue: still in its tracking window, least recently
-- checked first.
CREATE INDEX IF NOT EXISTS "alerts_fired_tracking_idx"
  ON "alerts_fired" ("tracked_until", "last_checked_at");
