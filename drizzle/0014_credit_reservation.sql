ALTER TABLE "scan_credits" ADD COLUMN IF NOT EXISTS "reserved_at" timestamp with time zone;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "scan_credits_reserved_at_idx" ON "scan_credits" USING btree ("reserved_at");
