import "server-only";
import { and, eq } from "drizzle-orm";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { getDb } from "./index";
import { paymentIntents } from "./schema";
import { hashNonce } from "./credits";

/** How long a quoted price/transaction stays valid before the buyer must re-quote. */
export const INTENT_TTL_MS = 5 * 60 * 1000;

export type PaymentMethod = "sol" | "usdc";

export interface CreateIntentInput {
  nonce: string;
  tier: number;
  method: PaymentMethod;
  payer: string;
  amount: number;
  mint: string | null;
  /** Credits this payment buys. `amount` is already multiplied by it. */
  quantity?: number;
  /** Account to attach the resulting credits to, if the buyer is signed in. */
  userId?: number | null;
}

export interface IntentRow {
  id: string;
  nonceHash: string;
  tier: number;
  method: string;
  payer: string;
  amount: number;
  mint: string | null;
  quantity: number;
  userId: number | null;
  status: string;
  signature: string | null;
  claimToken: string | null;
  expiresAt: Date;
}

export async function createPaymentIntent(input: CreateIntentInput): Promise<IntentRow | null> {
  const db = getDb();
  if (!db) return null;

  const id = randomUUID();
  const expiresAt = new Date(Date.now() + INTENT_TTL_MS);
  const [row] = await db
    .insert(paymentIntents)
    .values({
      id,
      nonceHash: hashNonce(input.nonce),
      tier: input.tier,
      method: input.method,
      payer: input.payer,
      amount: input.amount,
      mint: input.mint,
      quantity: input.quantity ?? 1,
      userId: input.userId ?? null,
      expiresAt,
    })
    .returning();
  return row as IntentRow;
}

/** Loads an intent and verifies the caller's nonce actually matches it before
 * returning anything — the intent id alone must never be sufficient. */
export async function getIntentForNonce(intentId: string, nonce: string): Promise<IntentRow | null> {
  const db = getDb();
  if (!db) return null;

  const rows = await db.select().from(paymentIntents).where(eq(paymentIntents.id, intentId)).limit(1);
  if (rows.length === 0) return null;
  const row = rows[0] as IntentRow;

  const expected = Buffer.from(row.nonceHash);
  const provided = Buffer.from(hashNonce(nonce));
  if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) return null;

  return row;
}

/** Atomically flips a pending intent to consumed, recording the verified
 * signature and the claim token it unlocked. Guards against double-spending
 * the same intent from two concurrent confirm calls. */
export async function consumePaymentIntent(
  intentId: string,
  signature: string,
  claimToken: string
): Promise<boolean> {
  const db = getDb();
  if (!db) return false;

  const updated = await db
    .update(paymentIntents)
    .set({ status: "consumed", signature, claimToken })
    .where(and(eq(paymentIntents.id, intentId), eq(paymentIntents.status, "pending")))
    .returning({ id: paymentIntents.id });

  return updated.length > 0;
}

export function isIntentExpired(row: IntentRow): boolean {
  return row.expiresAt.getTime() < Date.now();
}
