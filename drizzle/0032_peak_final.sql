-- Retire a dead coin's peak, so the rotation stops re-reading a fixed number.
--
-- The peak pass deliberately did NOT apply `DEAD_MCAP_USD`, on the reasoning
-- that a token which died still had a peak and that peak is exactly what the
-- record has to be right about. That reasoning is sound and this does not undo
-- it — it just notices that the argument only justifies checking a dead token
-- ONCE.
--
-- Measured on the live set: 345 tokens in the rotation, 200 of them already
-- below $4K, and 187 of those 200 already had a peak recorded. So 54% of a
-- budget capped by GeckoTerminal's ~30-calls-a-minute free tier was being spent
-- re-reading numbers that cannot move, while the calls currently running waited
-- 2.3 hours for their turn. The average call reaches its peak 58 minutes in,
-- which is inside the window that was being starved.
--
-- `peak_final` is set the first time a candle peak is reconciled for a token
-- whose last observed cap is under `DEAD_MCAP_USD`. A token under $4K cannot
-- print a new high above a peak it set on the way down without first trading
-- back up through it — and if it does, the spot sampler is what catches it,
-- because `applyMcapSample` still raises `ath_mcap_usd` with `greatest()` and is
-- not gated on this column. This only ever removes a token from the CANDLE
-- rotation.
ALTER TABLE "alerts_fired"
  ADD COLUMN IF NOT EXISTS "peak_final" boolean NOT NULL DEFAULT false;
--> statement-breakpoint

-- The rotation's new shape: skip the retired, then order by due-ness. Ahead of
-- `ath_checked_at` because it is the first thing filtered on, and `created_at`
-- is in the key because the due interval is chosen by the call's age.
CREATE INDEX IF NOT EXISTS "alerts_fired_peak_rotation_idx"
  ON "alerts_fired" ("chain", "peak_final", "tracked_until", "ath_checked_at");
--> statement-breakpoint

-- Backfill the 187 already-settled dead tokens, or the first sweep after this
-- deploys would still spend most of its budget on them. Conservative on purpose:
-- a token is only retired here if it has a peak AND is under the dead floor AND
-- has actually been reconciled against candles at least once. A token that only
-- ever had spot samples keeps its slot, because a candle read could still raise
-- its peak.
UPDATE "alerts_fired"
   SET "peak_final" = true
 WHERE "ath_mcap_usd" IS NOT NULL
   AND "ath_checked_at" IS NOT NULL
   AND coalesce("last_mcap_usd", "mcap_at_alert_usd", 0) < 4000;
