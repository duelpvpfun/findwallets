import "server-only";
import { and, eq } from "drizzle-orm";
import { getDb } from "./index";
import { walletDetailCache } from "./schema";
import type { Chain } from "../types";

/** Balances staying "fresh enough" against not re-billing upstream API credits
 * on every click — wallet-detail data doesn't need second-by-second accuracy. */
const TTL_MS = 15 * 60 * 1000;

export async function getCachedWalletDetail<T>(
  chain: Chain,
  tokenAddress: string,
  walletAddress: string
): Promise<T | null> {
  const db = getDb();
  if (!db) return null;
  try {
    const rows = await db
      .select({ payload: walletDetailCache.payload, fetchedAt: walletDetailCache.fetchedAt })
      .from(walletDetailCache)
      .where(
        and(
          eq(walletDetailCache.chain, chain),
          eq(walletDetailCache.tokenAddress, tokenAddress),
          eq(walletDetailCache.walletAddress, walletAddress)
        )
      )
      .limit(1);
    if (rows.length === 0) return null;
    const row = rows[0];
    if (Date.now() - row.fetchedAt.getTime() > TTL_MS) return null;
    return JSON.parse(row.payload) as T;
  } catch (err) {
    console.error("[getCachedWalletDetail] failed:", err);
    return null;
  }
}

/** Best-effort; caching is an optimization and must never fail the request it backs. */
export async function setCachedWalletDetail(
  chain: Chain,
  tokenAddress: string,
  walletAddress: string,
  payload: unknown
): Promise<void> {
  const db = getDb();
  if (!db) return;
  try {
    const json = JSON.stringify(payload);
    await db
      .insert(walletDetailCache)
      .values({ chain, tokenAddress, walletAddress, payload: json })
      .onConflictDoUpdate({
        target: [walletDetailCache.chain, walletDetailCache.tokenAddress, walletDetailCache.walletAddress],
        set: { payload: json, fetchedAt: new Date() },
      });
  } catch (err) {
    console.error("[setCachedWalletDetail] failed:", err);
  }
}
