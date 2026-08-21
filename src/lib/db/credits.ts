import "server-only";
import { and, desc, eq, gte, inArray, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import { createHash, randomBytes } from "node:crypto";
import { getDb } from "./index";
import { scanCredits, tokens, webhookLog } from "./schema";

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
  /** Credits this one payment buys. Only >1 for a signed-in buyer. */
  quantity?: number;
  nonceHash?: string | null;
  email?: string | null;
  payerWallet?: string | null;
  /** Account the credits belong to, when the buyer was signed in at quote time. */
  userId?: number | null;
}

/** Hard ceiling on a single purchase, so a mis-typed quantity can't quote $600. */
export const MAX_CREDIT_QUANTITY = 10;

/**
 * The `payment_id` for each credit a single transaction buys.
 *
 * The first keeps the bare signature, exactly as every credit created before
 * multi-buy existed — so `findCreditByPaymentId` and `/recover` keep working
 * unchanged for the primary credit, and so the unique index on `payment_id`
 * still makes a replayed confirm a no-op rather than a way to mint credits.
 */
function creditPaymentIds(signature: string, quantity: number): string[] {
  return Array.from({ length: quantity }, (_, i) => (i === 0 ? signature : `${signature}#${i}`));
}

/**
 * Creates the credits for one verified payment and returns their claim tokens,
 * in purchase order.
 *
 * Idempotent: a duplicate confirm for the same signature returns the existing
 * tokens rather than minting more. `onConflictDoNothing` is load-bearing — the
 * SELECT cannot stop two concurrent confirms, and without it the loser raises a
 * unique violation and the buyer sees a 500 for a payment that succeeded.
 */
export async function createCredits(input: CreateCreditInput): Promise<string[] | null> {
  const db = getDb();
  if (!db) return null;

  const quantity = Math.min(Math.max(1, Math.floor(input.quantity ?? 1)), MAX_CREDIT_QUANTITY);
  const ids = creditPaymentIds(input.paymentId, quantity);

  const read = async () =>
    db
      .select({ paymentId: scanCredits.paymentId, claimToken: scanCredits.claimToken })
      .from(scanCredits)
      .where(inArray(scanCredits.paymentId, ids));

  const existing = await read();
  const have = new Set(existing.map((r) => r.paymentId));
  const missing = ids.filter((id) => !have.has(id));

  if (missing.length > 0) {
    await db
      .insert(scanCredits)
      .values(
        missing.map((paymentId) => ({
          paymentId,
          method: input.method,
          tier: input.tier,
          claimToken: newClaimToken(),
          claimNonceHash: input.nonceHash ?? null,
          email: input.email ?? null,
          payerWallet: input.payerWallet ?? null,
          userId: input.userId ?? null,
        }))
      )
      .onConflictDoNothing({ target: scanCredits.paymentId });
  }

  const all = await read();
  const byId = new Map(all.map((r) => [r.paymentId, r.claimToken]));
  const claimTokens = ids.map((id) => byId.get(id)).filter((t): t is string => Boolean(t));
  return claimTokens.length > 0 ? claimTokens : null;
}

/** Single-credit convenience wrapper, for callers that never buy in bulk. */
export async function createCredit(input: CreateCreditInput): Promise<string | null> {
  const created = await createCredits({ ...input, quantity: 1 });
  return created?.[0] ?? null;
}

export interface CreditStatus {
  valid: boolean;
  tier: Tier | null;
  reason?: "not_found" | "already_used" | "reservation_pending" | "no_db";
}

/** Read-only status for the UI. Never use this to authorize a scan: the gap
 * between reading it and acting on it is a double-spend window — reserve instead. */
export async function checkCredit(claimToken: string): Promise<CreditStatus> {
  const db = getDb();
  if (!db) return { valid: false, tier: null, reason: "no_db" };

  const rows = await db
    .select({
      tier: scanCredits.tier,
      consumedAt: scanCredits.consumedAt,
      reservedAt: scanCredits.reservedAt,
    })
    .from(scanCredits)
    .where(eq(scanCredits.claimToken, claimToken))
    .limit(1);

  if (rows.length === 0) return { valid: false, tier: null, reason: "not_found" };
  const row = rows[0];
  // Still holding a reservation means the scan it was claimed for never reported
  // delivery. The buyer has not had their wallets, so this is not "already used"
  // — it is a scan in flight, or one that died and is about to be handed back.
  if (row.reservedAt) {
    return { valid: false, tier: row.tier as Tier, reason: "reservation_pending" };
  }
  if (row.consumedAt) return { valid: false, tier: row.tier as Tier, reason: "already_used" };
  return { valid: true, tier: row.tier as Tier };
}

/**
 * How long a reservation is trusted to belong to a live request. A scan pages
 * under SCAN_BUDGET_MS and finishes well inside this, so anything older is a
 * request that was killed — its owner may retake it and scan again immediately.
 * The cron sweeper is still the backstop for tokens nobody comes back for.
 */
const RETRY_TAKEOVER_MS = 2 * 60_000;

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
  const staleCutoff = new Date(now.getTime() - RETRY_TAKEOVER_MS);
  const reserved = await db
    .update(scanCredits)
    .set({
      consumedAt: now,
      consumedChain: chain,
      consumedTokenAddress: tokenAddress,
      reservedAt: now,
    })
    .where(
      and(
        eq(scanCredits.claimToken, claimToken),
        or(
          // Never spent.
          isNull(scanCredits.consumedAt),
          // Or spent on a scan that never reported delivery and is old enough to
          // be dead. Waiting for the sweeper here would tell a buyer whose scan
          // just crashed that their purchase was "already used" for the next ten
          // minutes, which is the single worst message this app can show.
          and(isNotNull(scanCredits.reservedAt), lt(scanCredits.reservedAt, staleCutoff))
        )
      )
    )
    .returning({ tier: scanCredits.tier });

  if (reserved.length > 0) return { valid: true, tier: reserved[0].tier as Tier };

  // Lost the race or never existed — distinguished only to give a clear message.
  return checkCredit(claimToken).then((status) =>
    status.valid ? { valid: false, tier: status.tier, reason: "already_used" } : status
  );
}

/**
 * Self-serve purchase recovery: maps an on-chain signature back to its credit
 * so a buyer whose browser lost the claim token isn't stranded.
 */
export async function findCreditByPaymentId(
  paymentId: string
): Promise<{ claimToken: string; tier: Tier; consumed: boolean } | null> {
  const db = getDb();
  if (!db) return null;

  const rows = await db
    .select({
      claimToken: scanCredits.claimToken,
      tier: scanCredits.tier,
      consumedAt: scanCredits.consumedAt,
    })
    .from(scanCredits)
    .where(eq(scanCredits.paymentId, paymentId))
    .limit(1);

  const row = rows[0];
  if (!row) return null;
  return { claimToken: row.claimToken, tier: row.tier as Tier, consumed: row.consumedAt !== null };
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

/* -------------------------------------------------------------------------- */
/* Account balance                                                            */
/* -------------------------------------------------------------------------- */

export interface CreditStatusWithToken extends CreditStatus {
  /** The claim token of the credit that was reserved, so the caller can settle
   * or release it through the existing single-credit paths. */
  claimToken?: string;
}

/**
 * Reserves one of a signed-in user's credits for this scan.
 *
 * Same compare-and-set as `reserveCredit`, applied to a set instead of a named
 * token: the inner SELECT picks a candidate under `FOR UPDATE SKIP LOCKED` and
 * the outer UPDATE re-asserts `consumed_at IS NULL`. Two concurrent scans
 * therefore either take two different credits or one takes a credit and the
 * other is refused — never both off the same purchase. This is NOT a
 * read-then-write; the read and the write are one statement.
 *
 * Ordered by tier ascending, then oldest first. The brief said oldest first; the
 * smallest *sufficient* tier is strictly better for the buyer, because burning a
 * Top 500 credit on a Top 100 scan when they also hold a Top 100 credit destroys
 * value they paid for.
 */
export async function reserveUserCredit(
  userId: number,
  minTier: number,
  chain: string,
  tokenAddress: string
): Promise<CreditStatusWithToken> {
  const db = getDb();
  if (!db) return { valid: false, tier: null, reason: "no_db" };

  const staleCutoff = new Date(Date.now() - RETRY_TAKEOVER_MS);
  // Bound as an ISO string with an explicit cast. A Date interpolated into a
  // hand-written `sql` fragment never reaches drizzle's type mapper, so
  // postgres.js receives the object itself and the bind fails.
  const staleCutoffIso = staleCutoff.toISOString();

  const rows = await db.execute<{ tier: number; claimToken: string }>(sql`
    update scan_credits set
      consumed_at = now(),
      consumed_chain = ${chain},
      consumed_token_address = ${tokenAddress},
      reserved_at = now()
    where id = (
      select id from scan_credits
      where user_id = ${userId}
        and tier >= ${minTier}
        and (
          consumed_at is null
          or (reserved_at is not null and reserved_at < ${staleCutoffIso}::timestamptz)
        )
      order by tier asc, created_at asc
      limit 1
      for update skip locked
    )
      and (
        consumed_at is null
        or (reserved_at is not null and reserved_at < ${staleCutoffIso}::timestamptz)
      )
    returning tier, claim_token as "claimToken"`);

  const row = rows[0];
  if (row) {
    return { valid: true, tier: Number(row.tier) as Tier, claimToken: row.claimToken };
  }

  // Nothing available. Distinguish "a scan of yours is still running" from
  // "you have no credits", because the two need completely different messages.
  const [pending] = await db
    .select({ tier: scanCredits.tier })
    .from(scanCredits)
    .where(
      and(
        eq(scanCredits.userId, userId),
        isNotNull(scanCredits.reservedAt),
        // Anything older than the cutoff would have been taken above.
        gte(scanCredits.reservedAt, staleCutoff),
        gte(scanCredits.tier, minTier)
      )
    )
    .limit(1);

  if (pending) {
    return { valid: false, tier: pending.tier as Tier, reason: "reservation_pending" };
  }
  return { valid: false, tier: null, reason: "not_found" };
}

export interface CreditBalance {
  /** Unspent credits, grouped by tier, largest tier first. */
  byTier: Array<{ tier: number; count: number }>;
  total: number;
  /** Largest tier the user can scan right now, or null with no credits. */
  bestTier: number | null;
  /** Credits currently held by a scan in flight. Not spendable, not lost. */
  pending: number;
}

/** Reads a user's spendable balance. Never authorizes a scan — reserve for that. */
export async function fetchCreditBalance(userId: number): Promise<CreditBalance> {
  const db = getDb();
  const empty: CreditBalance = { byTier: [], total: 0, bestTier: null, pending: 0 };
  if (!db) return empty;

  const rows = await db
    .select({
      tier: scanCredits.tier,
      available: sql<number>`count(*) filter (where ${scanCredits.consumedAt} is null)::int`,
      pending: sql<number>`count(*) filter (where ${scanCredits.reservedAt} is not null)::int`,
    })
    .from(scanCredits)
    .where(eq(scanCredits.userId, userId))
    .groupBy(scanCredits.tier)
    .orderBy(desc(scanCredits.tier));

  const byTier = rows
    .map((r) => ({ tier: r.tier, count: Number(r.available) }))
    .filter((r) => r.count > 0);

  return {
    byTier,
    total: byTier.reduce((sum, r) => sum + r.count, 0),
    bestTier: byTier.length > 0 ? Math.max(...byTier.map((r) => r.tier)) : null,
    pending: rows.reduce((sum, r) => sum + Number(r.pending), 0),
  };
}

export interface PurchaseRow {
  paymentId: string;
  method: string | null;
  tier: number;
  createdAt: Date;
  consumedAt: Date | null;
  consumedChain: string | null;
  consumedTokenAddress: string | null;
  consumedTokenSymbol: string | null;
}

/**
 * A user's purchase history, newest first, with the token each credit was spent
 * on. The symbol join mirrors the one in `adminStats.ts` — `scan_credits` stores
 * only the address, and "spent on 7GCi…pump" tells a buyer nothing.
 */
export async function fetchUserPurchases(userId: number, limit = 50): Promise<PurchaseRow[]> {
  const db = getDb();
  if (!db) return [];

  const rows = await db
    .select({
      paymentId: scanCredits.paymentId,
      method: scanCredits.method,
      tier: scanCredits.tier,
      createdAt: scanCredits.createdAt,
      consumedAt: scanCredits.consumedAt,
      consumedChain: scanCredits.consumedChain,
      consumedTokenAddress: scanCredits.consumedTokenAddress,
      consumedTokenSymbol: tokens.symbol,
    })
    .from(scanCredits)
    .leftJoin(
      tokens,
      and(
        eq(tokens.chain, sql`${scanCredits.consumedChain}`),
        sql`lower(${tokens.address}) = lower(${scanCredits.consumedTokenAddress})`
      )
    )
    .where(eq(scanCredits.userId, userId))
    .orderBy(desc(scanCredits.createdAt))
    .limit(limit);

  return rows;
}

/** The credit row behind a claim token, for attaching a scan result to it. */
export async function findCreditIdByClaimToken(claimToken: string): Promise<number | null> {
  const db = getDb();
  if (!db) return null;
  const [row] = await db
    .select({ id: scanCredits.id })
    .from(scanCredits)
    .where(eq(scanCredits.claimToken, claimToken))
    .limit(1);
  return row?.id ?? null;
}
