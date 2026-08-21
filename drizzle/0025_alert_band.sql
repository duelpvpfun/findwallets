-- Two corrections, both about not counting things that did not happen.
--
-- 1. `out_of_band`: a tier that crossed while the token's market cap was
--    outside the alerting range. The tier is still CLAIMED — otherwise it
--    would fire later on the same count — but it is not announced and not part
--    of the record. This is what makes the owner's rule work: two wallets in at
--    $5K is skipped, and when a third buys at $11K that step fires, with $11K
--    as the entry rather than the $5K nobody was told about.
--
-- 2. The peak was seeded from the entry cap, so a brand-new call read
--    "called at $3.2K, peak $3.2K" — a peak that had never been observed,
--    only assumed. `ath_mcap_usd` now starts NULL and is set by the first real
--    sample after the call, so "peak" means highest actually seen since. The
--    existing rows are recomputed the same way, from the stored series with
--    the alert-time sample excluded, so old and new calls are comparable.

ALTER TABLE "alerts_fired"
  ADD COLUMN IF NOT EXISTS "out_of_band" boolean NOT NULL DEFAULT false;
--> statement-breakpoint

-- Recompute peak and low from OBSERVED samples only. The alert-time sample is
-- the first entry in the series; anything within 60s of the call is it.
UPDATE "alerts_fired" a
SET
  "ath_mcap_usd" = obs.hi,
  "low_mcap_usd" = obs.lo
FROM (
  SELECT
    x.id,
    max((s->>1)::float8) AS hi,
    min((s->>1)::float8) AS lo
  FROM "alerts_fired" x, jsonb_array_elements(x."samples") s
  WHERE (s->>0)::bigint > extract(epoch FROM x."created_at") + 60
  GROUP BY x.id
) obs
WHERE a.id = obs.id;
--> statement-breakpoint

-- A call with no sample yet has no observed peak. Null, not the entry cap.
UPDATE "alerts_fired"
SET "ath_mcap_usd" = NULL, "low_mcap_usd" = NULL, "ath_at" = NULL, "low_at" = NULL
WHERE "samples" IS NULL
   OR jsonb_array_length("samples") <= 1;
--> statement-breakpoint

-- The tracker's work queue reads these together.
CREATE INDEX IF NOT EXISTS "alerts_fired_band_idx"
  ON "alerts_fired" ("chain", "out_of_band", "superseded");
