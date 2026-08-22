-- Move market-cap tracking onto free data sources.
--
-- Two columns and one table, all in service of the same correction: a running
-- maximum of spot checks is not an all-time high. $Link was recorded at $1.19M
-- because that was the highest of seven glances; the coin actually traded at
-- $2.22M, and its entire run above $1.3M lasted thirteen minutes. No polling
-- rate fixes that. Candle highs do, because a spike at 04:29 is in the 04:29
-- candle forever — which also means the ATH pass can be slow and still exact.
--
-- `ath_checked_at` drives a rotation rather than a schedule. Correctness no
-- longer depends on when we look, so the only job of the cadence is to keep the
-- displayed figure fresh within whatever a free rate limit allows: each sweep
-- takes the most stale tokens and works through the set.
ALTER TABLE "alerts_fired"
  ADD COLUMN IF NOT EXISTS "ath_checked_at" timestamptz;
--> statement-breakpoint

-- Rotation order: stalest first, and only for calls still being tracked.
CREATE INDEX IF NOT EXISTS "alerts_fired_ath_check_idx"
  ON "alerts_fired" ("chain", "tracked_until", "ath_checked_at");
--> statement-breakpoint

-- The pool a token trades in, cached.
--
-- GeckoTerminal's OHLCV endpoint is keyed by POOL, not by mint, so reading
-- candles costs a pool lookup first. The pool does not change, so paying that
-- lookup once per token instead of once per read is the difference between one
-- free call per sample and two — and the free tier is ~30 calls a minute, so
-- halving the cost doubles the rotation.
--
-- `source` is here because a token can be resolved by more than one provider
-- and a stale pool from a dead index should be re-resolvable without guessing
-- which one wrote it.
CREATE TABLE IF NOT EXISTS "token_pools" (
  "chain" text NOT NULL,
  "token_address" text NOT NULL,
  "pool_address" text NOT NULL,
  "source" text NOT NULL,
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("chain", "token_address")
);
