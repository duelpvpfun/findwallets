import "server-only";
import { and, eq, isNotNull, isNull, lt } from "drizzle-orm";
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
  // The SELECT above can't stop two concurrent confirms; without
  // onConflictDoNothing the loser raises a unique violation and the buyer sees a
  // 500 for a payment that actually succeeded.
  const inserted = await db
    .insert(scanCredits)
    .values({
      paymentId: input.paymentId,
      method: input.method,
      tier: input.tier,
      claimToken,
      claimNonceHash: input.nonceHash ?? null,
      email: input.email ?? null,
      payerWallet: input.payerWallet ?? null,
    })
    .onConflictDoNothing({ target: scanCredits.paymentId })
    .returning({ claimToken: scanCredits.claimToken });

  if (inserted.length > 0) return inserted[0].claimToken;

  const raced = await db
    .select({ claimToken: scanCredits.claimToken })
    .from(scanCredits)
    .where(eq(scanCredits.paymentId, input.paymentId))
    .limit(1);
  return raced[0]?.claimToken ?? null;
}

export interface CreditStatus {
  valid: boolean;
  tier: Tier | null;
  reason?: "not_found" | "already_used" | "no_db";
}

/** Read-only status for the UI. Never use this to authorize a scan: the gap
 * between reading it and acting on it is a double-spend window — reserve instead. */
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
 * Claims the credit up front, in a single atomic compare-and-set, and returns
 * the tier it unlocked. Checking validity first and consuming after the scan
 * would let N concurrent requests all pass the check and share one purchase;
 * the UPDATE ... WHERE consumed_at IS NULL can only win once.
 */
export async function reserveCredit(
  claimToken: string,
  chain: string,
  tokenAddress: string
): Promise<CreditStatus> {
  const db = getDb();
  if (!db) return { valid: false, tier: null, reason: "no_db" };

  const now = new Date();
  const reserved = await db
    .update(scanCredits)
    .set({
      consumedAt: now,
      consumedChain: chain,
      consumedTokenAddress: tokenAddress,
      reservedAt: now,
    })
    .where(and(eq(scanCredits.claimToken, claimToken), isNull(scanCredits.consumedAt)))
    .returning({ tier: scanCredits.tier });

  if (reserved.length > 0) return { valid: true, tier: reserved[0].tier as Tier };

  // Lost the race or never existed — distinguished only to give a clear message.
  return checkCredit(claimToken).then((status) =>
    status.valid ? { valid: false, tier: status.tier, reason: "already_used" } : status
  );
}

/**
 * Marks a reservation as safely delivered. Until this runs the credit is still
 * sweepable, so a function killed mid-scan gets refunded automatically.
 */
export async function confirmCreditDelivered(claimToken: string): Promise<void> {
  const db = getDb();
  if (!db) return;

  await db
    .update(scanCredits)
    .set({ reservedAt: null })
    .where(eq(scanCredits.claimToken, claimToken));
}

/**
 * Hands a reserved credit back when the scan it was reserved for delivered
 * nothing, so an empty result or upstream failure never costs the buyer.
 *
 * Scoped to the exact reservation: without the chain/token predicates a late or
 * duplicate release could un-consume a credit that a *different*, successful
 * scan had legitimately spent, handing out a free scan.
 */
export async function releaseCredit(
  claimToken: string,
  chain: string,
  tokenAddress: string
): Promise<boolean> {
  const db = getDb();
  if (!db) return false;

  const released = await db
    .update(scanCredits)
    .set({ consumedAt: null, consumedChain: null, consumedTokenAddress: null, reservedAt: null })
    .where(
      and(
        eq(scanCredits.claimToken, claimToken),
        isNotNull(scanCredits.consumedAt),
        eq(scanCredits.consumedChain, chain),
        eq(scanCredits.consumedTokenAddress, tokenAddress)
      )
    )
    .returning({ id: scanCredits.id });

  return released.length > 0;
}

/**
 * Safety net for every crash, timeout or deploy that interrupts a scan after
 * the credit was reserved. A reservation older than the grace window can no
 * longer belong to an in-flight request, so it is given back.
 */
export async function releaseStaleReservations(graceMinutes = 10): Promise<number> {
  const db = getDb();
  if (!db) return 0;

  const cutoff = new Date(Date.now() - graceMinutes * 60_000);
  const released = await db
    .update(scanCredits)
    .set({ consumedAt: null, consumedChain: null, consumedTokenAddress: null, reservedAt: null })
    .where(and(isNotNull(scanCredits.reservedAt), lt(scanCredits.reservedAt, cutoff)))
    .returning({ id: scanCredits.id });

  return released.length;
}
