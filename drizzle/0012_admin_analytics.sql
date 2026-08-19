-- Owner-only analytics. Nothing here is required by the product: both tables are
-- write-through counters read exclusively by /admin.

-- One row per page view. IPs are never stored raw — `visitor_hash` is a salted
-- digest, which is all that unique-visitor counting actually needs.
CREATE TABLE IF NOT EXISTS "site_visits" (
  "id" serial PRIMARY KEY,
  "path" text NOT NULL,
  "referrer" text,
  "country" text,
  "visitor_hash" text NOT NULL,
  "user_agent" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "site_visits_created_at_idx" ON "site_visits" ("created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "site_visits_visitor_idx" ON "site_visits" ("visitor_hash");
--> statement-breakpoint

-- Paid upstream spend, pre-aggregated per day/endpoint. A 500-wallet scan makes
-- ~50 Birdeye calls, so one row per call would cost more writes than the scan
-- itself — these are incremented in place instead.
CREATE TABLE IF NOT EXISTS "api_usage" (
  "id" serial PRIMARY KEY,
  "day" date NOT NULL,
  "provider" text NOT NULL,
  "endpoint" text NOT NULL,
  "calls" integer DEFAULT 0 NOT NULL,
  "credits" double precision DEFAULT 0 NOT NULL,
  "errors" integer DEFAULT 0 NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "api_usage_day_endpoint_idx" ON "api_usage" ("day", "provider", "endpoint");
