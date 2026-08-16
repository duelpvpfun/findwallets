import "server-only";
import { and, eq, gte, isNull } from "drizzle-orm";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { getDb } from "./index";
import { scanCredits } from "./schema";

export const TIERS = [100, 250, 500] as const;
export type Tier = (typeof TIERS)[number];

/** Maps each Helio paylink to the tier it unlocks. Server-side only — the
 * browser never decides which tier it bought. The retired 50 paylink stays
 * mapped so anyone who bought one before it was pulled can still redeem. */
export const PAYLINK_TIERS: Record<string, number> = {
  "6a8215d1f6597f12ce9fbea6": 50,
  "6a821074f6597f12ce9f98c4": 100,
  "6a8214f8a9d7742eda4f78b5": 250,
  "6a82154181e40c11230808b0": 500,
};

export function tierForPaylink(paylinkId: string): number | null {
  return PAYLINK_TIERS[paylinkId] ?? null;
}

export function newClaimToken(): string {
  return randomBytes(24).toString("base64url");
}

/** Nonces are stored hashed so a database leak can't be replayed to claim credits. */
export function hashNonce(nonce: string): string {
  return createHash("sha256").update(nonce).digest("hex");
}

export interface CreateCreditInput {
  paymentId: string;
  paylinkId: string;
  tier: number;
  nonceHash?: string | null;
  email?: string | null;
  payerWallet?: string | null;
}

/** Idempotent: a duplicate webhook for the same payment returns the existing token. */
export async function createCredit(input: CreateCreditInput): Promise<string | null> {
  const db = getDb();
  if (!db) return null;

  const existing = await db
    .select({ claimToken: scanCredits.claimToken })
    .from(scanCredits)
    .where(eq(scanCredits.paymentId, input.paymentId))
    .limit(1);
  if (existing.length > 0) return existing[0].claimToken;

  const claimToken = newClaimToken();
  await db.insert(scanCredits).values({
    paymentId: input.paymentId,
    paylinkId: input.paylinkId,
    tier: input.tier,
    claimToken,
    claimNonceHash: input.nonceHash ?? null,
    email: input.email ?? null,
    payerWallet: input.payerWallet ?? null,
  });
  return claimToken;
}

export type ReleaseResult =
  | { status: "ok"; claimToken: string; tier: Tier }
  | { status: "pending" }
  | { status: "forbidden" }
  | { status: "no_db" };

/**
 * Hands the claim token to the buyer's browser.
 *
 * `paymentId` is a public on-chain signature, so it is treated as an identifier
 * and never as a credential: release additionally requires the nonce the buyer
 * generated before paying, and only happens while the credit is unclaimed and
 * unspent. Anyone watching the merchant wallet therefore learns nothing usable.
 */
export async function releaseClaim(paymentId: string, nonce: string): Promise<ReleaseResult> {
  const db = getDb();
  if (!db) return { status: "no_db" };

  const rows = await db
    .select({
      id: scanCredits.id,
      claimToken: scanCredits.claimToken,
      tier: scanCredits.tier,
      nonceHash: scanCredits.claimNonceHash,
      claimedAt: scanCredits.claimedAt,
      consumedAt: scanCredits.consumedAt,
    })
    .from(scanCredits)
    .where(eq(scanCredits.paymentId, paymentId))
    .limit(1);

  if (rows.length === 0) return { status: "pending" };
  const row = rows[0];

  if (!row.nonceHash) return { status: "forbidden" };
  const expected = Buffer.from(row.nonceHash);
  const provided = Buffer.from(hashNonce(nonce));
  if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) {
    return { status: "forbidden" };
  }

  if (row.consumedAt) return { status: "forbidden" };

  // Re-releasing to the same nonce holder is safe and keeps refreshes working,
  // but the row is stamped so the handoff is auditable.
  const updated = await db
    .update(scanCredits)
    .set({ claimedAt: row.claimedAt ?? new Date() })
    .where(and(eq(scanCredits.id, row.id), isNull(scanCredits.consumedAt)))
    .returning({ id: scanCredits.id });

  if (updated.length === 0) return { status: "forbidden" };
  return { status: "ok", claimToken: row.claimToken, tier: row.tier as Tier };
}

/**
 * Fallback for when Helio's webhook payload doesn't echo the buyer's nonce back
 * to us: the first caller to present a nonce for an unbound credit claims it.
 *
 * This is deliberately narrow. Binding is refused once the credit has been
 * claimed, consumed, or is older than BIND_WINDOW_MS — the legitimate buyer's
 * browser polls within a second of checkout, long before a third party watching
 * the merchant wallet could react. Set CLAIM_REQUIRE_NONCE=true to disable this
 * path entirely once you've confirmed the nonce survives the round trip.
 */
const BIND_WINDOW_MS = 15 * 60 * 1000;

export async function bindNonceToPayment(paymentId: string, nonceHash: string): Promise<boolean> {
  if (process.env.CLAIM_REQUIRE_NONCE === "true") return false;

  const db = getDb();
  if (!db) return false;

  const updated = await db
    .update(scanCredits)
    .set({ claimNonceHash: nonceHash })
    .where(
      and(
        eq(scanCredits.paymentId, paymentId),
        isNull(scanCredits.claimNonceHash),
        isNull(scanCredits.claimedAt),
        isNull(scanCredits.consumedAt),
        gte(scanCredits.createdAt, new Date(Date.now() - BIND_WINDOW_MS))
      )
    )
    .returning({ id: scanCredits.id });

  return updated.length > 0;
}

export interface CreditStatus {
  valid: boolean;
  tier: Tier | null;
  reason?: "not_found" | "already_used" | "no_db";
}

export async function checkCredit(claimToken: string): Promise<CreditStatus> {
  const db = getDb();
  if (!db) return { valid: false, tier: null, reason: "no_db" };

  const rows = await db
    .select({ tier: scanCredits.tier, consumedAt: scanCredits.consumedAt })
    .from(scanCredits)
    .where(eq(scanCredits.claimToken, claimToken))
    .limit(1);

  if (rows.length === 0) return { valid: false, tier: null, reason: "not_found" };
  if (rows[0].consumedAt) return { valid: false, tier: rows[0].tier as Tier, reason: "already_used" };
  return { valid: true, tier: rows[0].tier as Tier };
}

/**
 * Marks a credit used. Only called after a scan actually returned traders, so a
 * failed or empty scan never burns the buyer's payment.
 * The `isNull(consumedAt)` guard makes concurrent redemptions safe.
 */
export async function consumeCredit(
  claimToken: string,
  chain: string,
  tokenAddress: string
): Promise<boolean> {
  const db = getDb();
  if (!db) return false;

  const updated = await db
    .update(scanCredits)
    .set({ consumedAt: new Date(), consumedChain: chain, consumedTokenAddress: tokenAddress })
    .where(and(eq(scanCredits.claimToken, claimToken), isNull(scanCredits.consumedAt)))
    .returning({ id: scanCredits.id });

  return updated.length > 0;
}
