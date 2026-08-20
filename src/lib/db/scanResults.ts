import "server-only";
import { and, desc, eq, isNull, lt, or, sql } from "drizzle-orm";
import { getDb } from "./index";
import { scanResults } from "./schema";
import type { ScanResult } from "../types";

/**
 * The 7-day receipt for a paid scan.
 *
 * Retention is a promise to the user, not a capacity limit. A 500-trader payload
 * is ~150KB of JSON and Postgres TOAST-compresses large JSONB out of line, so
 * call it ~40KB stored; a thousand scans a month is ~40MB against 8GB. Nobody
 * should believe the database couldn't hold more — seven days is the commitment
 * that was made, and the purge honours it rather than being forced by it.
 */
export const RETENTION_DAYS = 7;

/** Beyond this a user cannot pin more results. Pinning is free; unbounded isn't. */
export const MAX_PINNED = 2;

export interface StoredScanSummary {
  id: number;
  chain: string;
  tokenAddress: string;
  tokenSymbol: string | null;
  traderCount: number;
  requestedCount: number | null;
  pinned: boolean;
  createdAt: Date;
  expiresAt: Date;
}

export interface SaveScanResultInput {
  userId: number | null;
  creditId: number | null;
  result: ScanResult;
}

/**
 * Stores the delivered payload, unfiltered.
 *
 * Deliberately keeps every trader row, including the ones that didn't clear the
 * quality bar: this is a receipt for something someone paid for, and handing
 * back a filtered subset is handing back a different product. The only field
 * dropped is `scanSession` — an HMAC credential with nothing to gain from being
 * at rest, re-issued fresh on re-download.
 *
 * Best-effort. Never called on the request's critical path and never allowed to
 * throw into it: a failure to write the receipt must not fail the scan.
 */
export async function saveScanResult(input: SaveScanResultInput): Promise<number | null> {
  const db = getDb();
  if (!db) return null;

  // Nothing to attach it to means nothing could ever read it back.
  if (input.userId === null && input.creditId === null) return null;

  // The scan session is a short-lived HMAC credential with nothing to gain from
  // being at rest. Everything else is kept exactly as delivered.
  const payload: ScanResult = { ...input.result };
  delete payload.scanSession;

  const expiresAt = new Date(Date.now() + RETENTION_DAYS * 86_400_000);

  const [row] = await db
    .insert(scanResults)
    .values({
      userId: input.userId,
      creditId: input.creditId,
      chain: input.result.token.chain,
      tokenAddress: input.result.token.address,
      tokenSymbol: input.result.token.symbol,
      traderCount: input.result.traders.length,
      requestedCount: input.result.requestedCount ?? null,
      payload,
      expiresAt,
    })
    .returning({ id: scanResults.id });

  return row?.id ?? null;
}

/** A user's stored scans, newest first. Never selects `payload` — that column is
 * the whole point of this table being separate from `scan_credits`. */
export async function fetchUserScanResults(
  userId: number,
  limit = 30
): Promise<StoredScanSummary[]> {
  const db = getDb();
  if (!db) return [];

  return db
    .select({
      id: scanResults.id,
      chain: scanResults.chain,
      tokenAddress: scanResults.tokenAddress,
      tokenSymbol: scanResults.tokenSymbol,
      traderCount: scanResults.traderCount,
      requestedCount: scanResults.requestedCount,
      pinned: scanResults.pinned,
      createdAt: scanResults.createdAt,
      expiresAt: scanResults.expiresAt,
    })
    .from(scanResults)
    .where(
      and(
        eq(scanResults.userId, userId),
        // Expired-but-not-yet-purged rows are already gone as far as the user is
        // concerned. Showing one and then failing the download is worse than
        // never listing it.
        or(eq(scanResults.pinned, true), sql`${scanResults.expiresAt} > now()`)
      )
    )
    .orderBy(desc(scanResults.createdAt))
    .limit(limit);
}

/**
 * One stored payload, scoped to its owner.
 *
 * The `user_id` predicate is the authorization: a sequential id is guessable, so
 * without it any signed-in user could enumerate everyone else's paid results.
 */
export async function fetchScanResultPayload(
  userId: number,
  id: number
): Promise<{ payload: ScanResult; expiresAt: Date; pinned: boolean } | null> {
  const db = getDb();
  if (!db) return null;

  const [row] = await db
    .select({
      payload: scanResults.payload,
      expiresAt: scanResults.expiresAt,
      pinned: scanResults.pinned,
    })
    .from(scanResults)
    .where(and(eq(scanResults.id, id), eq(scanResults.userId, userId)))
    .limit(1);

  if (!row) return null;
  if (!row.pinned && row.expiresAt.getTime() <= Date.now()) return null;

  return {
    payload: row.payload as ScanResult,
    expiresAt: row.expiresAt,
    pinned: row.pinned,
  };
}

export type PinOutcome = "pinned" | "unpinned" | "limit_reached" | "not_found" | "no_db";

/**
 * Pins or unpins a result. Pinned results ignore the retention window.
 *
 * The count check and the update are two statements, so two simultaneous pins
 * could in principle land a third. That is a cosmetic overshoot on a
 * free-to-the-user feature, not a money path — worth far less than the locking
 * needed to prevent it.
 */
export async function setScanResultPinned(
  userId: number,
  id: number,
  pinned: boolean
): Promise<PinOutcome> {
  const db = getDb();
  if (!db) return "no_db";

  if (pinned) {
    const [row] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(scanResults)
      .where(and(eq(scanResults.userId, userId), eq(scanResults.pinned, true)));
    if (Number(row?.count ?? 0) >= MAX_PINNED) return "limit_reached";
  }

  const updated = await db
    .update(scanResults)
    .set({ pinned })
    .where(and(eq(scanResults.id, id), eq(scanResults.userId, userId)))
    .returning({ id: scanResults.id });

  if (updated.length === 0) return "not_found";
  return pinned ? "pinned" : "unpinned";
}

/**
 * Deletes results past their retention window. Pinned rows are kept, and rows
 * that were never attached to a user or a credit are dropped on the same
 * schedule — they are unreachable by anyone.
 */
export async function purgeExpiredScanResults(): Promise<number> {
  const db = getDb();
  if (!db) return 0;

  const deleted = await db
    .delete(scanResults)
    .where(and(eq(scanResults.pinned, false), lt(scanResults.expiresAt, new Date())))
    .returning({ id: scanResults.id });

  return deleted.length;
}

/** Orphans: written before a sign-in attached the credit, and never claimed. */
export async function countOrphanedScanResults(): Promise<number> {
  const db = getDb();
  if (!db) return 0;
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(scanResults)
    .where(isNull(scanResults.userId));
  return Number(row?.count ?? 0);
}
