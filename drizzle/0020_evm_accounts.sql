-- EVM wallets can hold an account too.
--
-- The tool ranks traders on BNB Chain and Base as well as Solana, so a large
-- share of customers arrive with MetaMask or Rabby and no Solana wallet at all.
-- Sign-in was Ed25519-only, which meant those users could not have an account,
-- and without an account a purchase lives or dies with their localStorage.
--
-- `wallet` holds both families in one column: base58 Solana keys and lowercased
-- `0x` EVM addresses are disjoint formats, so the unique index cannot collide.
-- `wallet_chain` is derivable from the address, but storing it keeps the UI and
-- any future "link a second wallet" feature from having to re-derive it.
--
-- Every existing row is a Solana account, which is exactly what the default
-- backfills, so this is safe to apply while signed-in sessions are live.

ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "wallet_chain" text DEFAULT 'solana' NOT NULL;
