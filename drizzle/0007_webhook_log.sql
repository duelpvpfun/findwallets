-- Helio deliveries were failing with no trace on our side, so every attempt is
-- recorded here (including rejected ones) to show what actually arrives.
CREATE TABLE IF NOT EXISTS "webhook_log" (
  "id" serial PRIMARY KEY NOT NULL,
  "outcome" text NOT NULL,
  "auth_header" text,
  "header_names" text,
  "query" text,
  "body" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "webhook_log_created_at_idx" ON "webhook_log" ("created_at");
