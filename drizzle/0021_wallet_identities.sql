-- Where a wallet's name and X handle came from.
--
-- `identity_name` / `twitter` were previously only ever written by a scan, from
-- whatever the upstream provider happened to attach. Curated identity imports
-- (`scripts/import-kol-wallets.mjs`) write the same two columns, and the two
-- sources need telling apart for one concrete reason: `purge-noncompliant.mjs`
-- deletes any wallet left with no compliant trade and no GMGN win badges, which
-- is exactly the shape of a freshly imported identity row. A curated row is a
-- directory entry, not a scan leftover, so it is exempt.
--
-- Null means "scan-derived, or unknown", which is every existing row.

ALTER TABLE "wallets"
  ADD COLUMN IF NOT EXISTS "identity_source" text;
