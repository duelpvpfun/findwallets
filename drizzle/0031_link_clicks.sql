-- Every tap on a buy link, from the channel or from the site.
--
-- The alerts and the feed exist partly to send buyers to a venue, and until now
-- nothing recorded whether anybody went. "Which venue do readers actually use"
-- and "does Telegram or the site drive the traffic" are both questions a
-- referral dashboard cannot answer, because it only ever sees the clicks that
-- converted on ONE venue and nothing about the ones that did not.
--
-- Written from `/api/go`, which is the only thing that redirects a reader
-- outward. The destination is always rebuilt server-side from the venue slug, so
-- this table can never be used to point somebody at an arbitrary URL.
CREATE TABLE IF NOT EXISTS "link_clicks" (
  "id" serial PRIMARY KEY NOT NULL,
  -- "tg" for a channel button, "feed" for the live feed, "scan" for a results
  -- page. Short because it rides in the query string of a Telegram button.
  "source" text NOT NULL,
  -- `TradeLink.slug`, or "chart" for the Dexscreener button beside them.
  "venue" text NOT NULL,
  "chain" text NOT NULL,
  "token_address" text NOT NULL,
  -- Salted digest of IP + user agent, exactly as `site_visits` does it: enough
  -- to tell forty taps from one person apart from forty people, and never the
  -- raw address. Null for a click we could not attribute.
  "visitor_hash" text,
  "country" text,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint

-- Every panel filters by window first.
CREATE INDEX IF NOT EXISTS "link_clicks_created_at_idx" ON "link_clicks" ("created_at");
--> statement-breakpoint

-- The venue rollup, which is the headline: clicks per venue per window.
CREATE INDEX IF NOT EXISTS "link_clicks_venue_created_idx"
  ON "link_clicks" ("venue", "created_at");
--> statement-breakpoint

-- "which call drove the traffic" — grouped by token inside a window.
CREATE INDEX IF NOT EXISTS "link_clicks_token_created_idx"
  ON "link_clicks" ("chain", "token_address", "created_at");
