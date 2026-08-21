-- Apply the alerting band retroactively.
--
-- The band ($10K-$1M) started being enforced at fire time in 0025, but 67 calls
-- had already fired outside it. The owner's rule is that those coins are hidden
-- on the site and in the channel, not merely un-alerted from now on — so the
-- flag is backfilled and stays the single source of truth for "is this part of
-- the record". Filtering by cap at read time as well would be a second answer
-- to the same question, and the two would eventually disagree.
--
-- Rows with no cap at all are left alone: unknown is not the same as
-- out-of-range, and an upstream lookup that failed should not silently erase a
-- real call.
UPDATE "alerts_fired"
SET "out_of_band" = true,
    "delivery_error" = coalesce("delivery_error", 'out-of-band-backfilled')
WHERE "out_of_band" = false
  AND "mcap_at_alert_usd" IS NOT NULL
  AND ("mcap_at_alert_usd" < 10000 OR "mcap_at_alert_usd" > 1000000);
