-- A wallet the owner has ruled out by hand.
--
-- Deactivating in `alert_wallets` is not enough on its own: the roster is
-- rebuilt from `wallet_tokens` every time `alerts:sync --apply` runs, so a
-- wallet removed today walks straight back in on the next sync and nobody
-- notices. The block has to live on the wallet, next to the evidence that
-- qualified it, or the removal silently undoes itself.
--
-- Separate from `is_bot`, which means "an upstream provider tagged this as a
-- bot" and is set by automation. This one means "a human looked at it and said
-- no", and the two must not be able to overwrite each other.
ALTER TABLE "wallets"
  ADD COLUMN IF NOT EXISTS "blocked" boolean NOT NULL DEFAULT false;
--> statement-breakpoint

ALTER TABLE "wallets"
  ADD COLUMN IF NOT EXISTS "blocked_reason" text;
--> statement-breakpoint

-- The roster query filters on it, so it wants the same shape as the rest of
-- that predicate.
CREATE INDEX IF NOT EXISTS "wallets_blocked_idx" ON "wallets" ("chain", "blocked");
