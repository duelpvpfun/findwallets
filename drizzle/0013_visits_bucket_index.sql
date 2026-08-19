-- Every dashboard panel filters site_visits by a time window and counts distinct
-- visitors. The existing single-column indexes force a heap lookup per row for
-- the hash; this covering index answers the window+distinct queries from the
-- index alone, which is what keeps the page fast as the table grows.
CREATE INDEX IF NOT EXISTS "site_visits_created_visitor_idx"
  ON "site_visits" ("created_at", "visitor_hash");
