import "server-only";
import { and, eq, isNull } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import { getDb } from "./index";
import { scanCredits } from "./schema";

export const TIERS = [50, 100, 250, 500] as const;
export type Tier = (typeof TIERS)[number];

/** Maps each Helio paylink to the tier it unlocks. Server-side only — the
 * browser never decides which tier it bought. */
export const PAYLINK_TIERS: Record<string, Tier> = {
  "6a8215d1f6597f12ce9fbea6": 50,
  "6a821074f6597f12ce9f98c4": 100,
  "6a8214f8a9d7742eda4f78b5": 250,
  "6a82154181e40c11230808b0": 500,
};

export function tierForPaylink(paylinkId: string): Tier | null {
  return PAYLINK_TIERS[paylinkId] ?? null;
}

export function newClaimToken(): string {
  return randomBytes(24).toString("base64url");
}

export interface CreateCreditInput {
  paymentId: string;
  paylinkId: string;
  tier: Tier;
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
    email: input.email ?? null,
    payerWallet: input.payerWallet ?? null,
  });
  return claimToken;
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
