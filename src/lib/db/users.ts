import "server-only";
import { and, eq, isNull, lt, sql } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import { getDb } from "./index";
import { authNonces, scanCredits, scanResults, users } from "./schema";

/** A challenge older than this is refused, used or not. */
export const NONCE_TTL_MS = 5 * 60 * 1000;

export interface AuthUser {
  id: number;
  wallet: string;
  displayName: string | null;
}

export function newNonce(): string {
  return randomBytes(24).toString("base64url");
}

/**
 * Issues a single-use challenge bound to one wallet.
 *
 * Stored in full rather than hashed, unlike the claim-token nonces in
 * `credits.ts`: this value is worthless on its own — redeeming it needs a
 * signature from the wallet's private key — and the verify step has to rebuild
 * the exact signed message from it, which a hash would make impossible.
 */
export async function createAuthNonce(wallet: string): Promise<string | null> {
  const db = getDb();
  if (!db) return null;

  const nonce = newNonce();
  await db.insert(authNonces).values({ nonce, wallet });
  return nonce;
}

export type NonceRejection = "not_found" | "already_used" | "expired" | "no_db";

/**
 * Claims a challenge, atomically, and returns the wallet it was issued to.
 *
 * A single `UPDATE ... WHERE used_at IS NULL ... RETURNING` for the same reason
 * `reserveCredit` uses one: read-then-write would let two concurrent verify
 * calls both pass the check and both mint a session off one challenge.
 *
 * Claimed BEFORE the signature is checked, deliberately. A wrong signature burns
 * the nonce, which is exactly what single-use should mean — otherwise a caller
 * could hammer one challenge with guesses.
 */
export async function consumeAuthNonce(
  nonce: string,
  wallet: string
): Promise<{ ok: true } | { ok: false; reason: NonceRejection }> {
  const db = getDb();
  if (!db) return { ok: false, reason: "no_db" };

  const cutoff = new Date(Date.now() - NONCE_TTL_MS);
  const claimed = await db
    .update(authNonces)
    .set({ usedAt: new Date() })
    .where(
      and(
        eq(authNonces.nonce, nonce),
        // Bound to the wallet it was issued for: a challenge handed to one
        // address must not be redeemable by a signature from another.
        eq(authNonces.wallet, wallet),
        isNull(authNonces.usedAt),
        sql`${authNonces.createdAt} > ${cutoff}`
      )
    )
    .returning({ nonce: authNonces.nonce });

  if (claimed.length > 0) return { ok: true };

  // Lost the race, expired, or never existed. Distinguished only for the log —
  // the caller returns one indistinguishable message either way, so a prober
  // learns nothing about which challenges exist.
  const [existing] = await db
    .select({ usedAt: authNonces.usedAt, createdAt: authNonces.createdAt })
    .from(authNonces)
    .where(eq(authNonces.nonce, nonce))
    .limit(1);

  if (!existing) return { ok: false, reason: "not_found" };
  if (existing.usedAt) return { ok: false, reason: "already_used" };
  return { ok: false, reason: "expired" };
}

/**
 * The account for this wallet, creating it on first sign-in, then attaching
 * every purchase that wallet already paid for.
 *
 * The backfill is what makes accounts useful on day one instead of empty:
 * `scan_credits.payer_wallet` has been recorded on every confirmed payment since
 * launch, so a buyer who has been redeeming by claim token sees their whole
 * history the moment they sign in. `user_id IS NULL` scopes it, so a credit
 * already attached to an account is never moved.
 */
export async function upsertUserAndClaimHistory(wallet: string): Promise<AuthUser | null> {
  const db = getDb();
  if (!db) return null;

  const [row] = await db
    .insert(users)
    .values({ wallet })
    .onConflictDoUpdate({
      target: users.wallet,
      set: { lastSeenAt: new Date() },
    })
    .returning({ id: users.id, wallet: users.wallet, displayName: users.displayName });

  if (!row) return null;

  // Sequential, never Promise.all: postgres.js pipelines concurrent queries and
  // a fan-out wider than the pool hangs against Supabase's pooler.
  await db
    .update(scanCredits)
    .set({ userId: row.id })
    .where(and(eq(scanCredits.payerWallet, wallet), isNull(scanCredits.userId)));

  // Results delivered against those credits follow them onto the account, so
  // the profile's scan history is populated too rather than starting blank.
  await db.execute(sql`
    update ${scanResults} set user_id = ${row.id}
    where user_id is null
      and credit_id in (
        select ${scanCredits.id} from ${scanCredits} where ${scanCredits.userId} = ${row.id}
      )`);

  return row;
}

/** Absorbs a browser-held claim token into an account. */
export type AbsorbOutcome = "absorbed" | "already_mine" | "spent" | "unknown" | "no_db";

/**
 * Attaches an anonymous claim token to a signed-in account.
 *
 * Not a privilege escalation: whoever holds a claim token can already redeem it,
 * so moving it onto their account grants nothing new. Scoped to credits that are
 * unspent and unattached, so it can never steal a purchase from another account
 * or resurrect one that has been used.
 */
export async function absorbClaimToken(
  userId: number,
  claimToken: string
): Promise<AbsorbOutcome> {
  const db = getDb();
  if (!db) return "no_db";

  const attached = await db
    .update(scanCredits)
    .set({ userId })
    .where(
      and(
        eq(scanCredits.claimToken, claimToken),
        isNull(scanCredits.userId),
        isNull(scanCredits.consumedAt)
      )
    )
    .returning({ id: scanCredits.id });

  if (attached.length > 0) return "absorbed";

  const [existing] = await db
    .select({ userId: scanCredits.userId, consumedAt: scanCredits.consumedAt })
    .from(scanCredits)
    .where(eq(scanCredits.claimToken, claimToken))
    .limit(1);

  if (!existing) return "unknown";
  if (existing.userId === userId) return "already_mine";
  if (existing.consumedAt) return "spent";
  // Belongs to someone else's account. Reported as unknown: confirming that a
  // token exists but isn't yours is information the caller has no use for.
  return "unknown";
}

export async function touchUser(userId: number): Promise<void> {
  const db = getDb();
  if (!db) return;
  await db.update(users).set({ lastSeenAt: new Date() }).where(eq(users.id, userId));
}

export async function findUserById(userId: number): Promise<AuthUser | null> {
  const db = getDb();
  if (!db) return null;
  const [row] = await db
    .select({ id: users.id, wallet: users.wallet, displayName: users.displayName })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return row ?? null;
}

/**
 * Drops challenges older than a day. They are single-use and expire in five
 * minutes, so anything left is dead weight — but an unswept table is an
 * append-only log of every sign-in attempt, growing forever.
 */
export async function purgeOldNonces(olderThanHours = 24): Promise<number> {
  const db = getDb();
  if (!db) return 0;

  const cutoff = new Date(Date.now() - olderThanHours * 3_600_000);
  const deleted = await db
    .delete(authNonces)
    .where(lt(authNonces.createdAt, cutoff))
    .returning({ nonce: authNonces.nonce });
  return deleted.length;
}
