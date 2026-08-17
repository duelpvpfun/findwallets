-- The claim route now resolves a credit by nonce first, because Helio's payload
-- field carrying the payment id varies and left paid credits stuck as pending.
CREATE INDEX IF NOT EXISTS "scan_credits_claim_nonce_hash_idx" ON "scan_credits" ("claim_nonce_hash");
