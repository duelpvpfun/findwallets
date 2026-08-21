-- Making the scoreboard able to show a loss.
--
-- `ath_mcap_usd` is a running maximum seeded at the entry cap, so
-- `ath / entry` is >= 1.00 by construction. Every call therefore looked like it
-- at least broke even, and the "average peak" was an upper bound presented as a
-- result. A scoreboard that cannot express a losing call is worse than no
-- scoreboard, because it is confidently wrong.
--
-- Two additions fix it:
--
--   low_mcap_usd    the running MINIMUM — the drawdown. This is the number that
--                   says whether a call would have stopped you out before it
--                   ever ran, and it is the honest counterweight to the peak.
--                   (Maximum adverse excursion, against the peak's maximum
--                   favourable excursion.)
--
--   mcap_{1,6,24}h  the cap at fixed ages, snapshotted once each. These are the
--                   only figures that answer "what would I actually have made
--                   holding this", because nobody sells the exact top.
--
-- All of it is backfilled from the `samples` series already on each row, so the
-- existing calls are scored on the same basis as new ones rather than starting
-- the record over.

ALTER TABLE "alerts_fired"
  ADD COLUMN IF NOT EXISTS "low_mcap_usd" double precision,
  ADD COLUMN IF NOT EXISTS "low_at" timestamptz,
  ADD COLUMN IF NOT EXISTS "mcap_1h_usd" double precision,
  ADD COLUMN IF NOT EXISTS "mcap_6h_usd" double precision,
  ADD COLUMN IF NOT EXISTS "mcap_24h_usd" double precision;
--> statement-breakpoint

-- Backfill the drawdown from the recorded series. Each sample is [unix, mcap].
UPDATE "alerts_fired"
SET "low_mcap_usd" = least(
      coalesce("mcap_at_alert_usd", 'infinity'::float8),
      (SELECT min((s->>1)::float8) FROM jsonb_array_elements("samples") s)
    )
WHERE "low_mcap_usd" IS NULL
  AND jsonb_array_length("samples") > 0;
--> statement-breakpoint

-- And the fixed-age caps: the first sample at or after each mark.
UPDATE "alerts_fired" a
SET
  "mcap_1h_usd" = (
    SELECT (s->>1)::float8 FROM jsonb_array_elements(a."samples") s
    WHERE (s->>0)::bigint >= extract(epoch FROM a."created_at") + 3600
    ORDER BY (s->>0)::bigint LIMIT 1),
  "mcap_6h_usd" = (
    SELECT (s->>1)::float8 FROM jsonb_array_elements(a."samples") s
    WHERE (s->>0)::bigint >= extract(epoch FROM a."created_at") + 21600
    ORDER BY (s->>0)::bigint LIMIT 1),
  "mcap_24h_usd" = (
    SELECT (s->>1)::float8 FROM jsonb_array_elements(a."samples") s
    WHERE (s->>0)::bigint >= extract(epoch FROM a."created_at") + 86400
    ORDER BY (s->>0)::bigint LIMIT 1)
WHERE jsonb_array_length(a."samples") > 0;
