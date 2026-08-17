import "server-only";
import { and, eq, isNull } from "drizzle-orm";
import { createHash, randomBytes } from "node:crypto";
import { getDb } from "./index";
import { scanCredits, webhookLog } from "./schema";

export const TIERS = [50, 100, 250, 500] as const;
export type Tier = (typeof TIERS)[number];

/** Diagnostics only; never allowed to fail the confirm request it is recording. */
export async function logWebhook(entry: {
  outcome: string;
  authHeader: string;
  headerNames: string;
  query: string;
  body: string;
}): Promise<void> {
  try {
    await getDb()?.insert(webhookLog).values(entry);
  } catch {
    // ignored
  }
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
  method: string;
  tier: number;
  nonceHash?: string | null;
  email?: string | null;
  payerWallet?: string | null;
}

/** Idempotent: a duplicate confirm for the same payment returns the existing token. */
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
    method: input.method,
    tier: input.tier,
    claimToken,
    claimNonceHash: input.nonceHash ?? null,
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
