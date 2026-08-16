import "server-only";
import { and, eq, inArray, isNotNull, gt } from "drizzle-orm";
import { getDb } from "./index";
import { wallets } from "./schema";
import type { Chain } from "../types";

/** Re-enrich a wallet only after its lifetime stats go stale. */
const STALE_AFTER_DAYS = 14;

/**
 * Returns the subset of addresses that still need lifetime enrichment — i.e.
 * never enriched, or enriched longer ago than STALE_AFTER_DAYS. Skipping the
 * rest is what keeps repeat scans cheap (Birdeye bills 35 CU per wallet).
 * With no database configured, everything is treated as needing enrichment.
 */
export async function filterNeedsEnrichment(
  chain: Chain,
  addresses: string[]
): Promise<string[]> {
  const db = getDb();
  if (!db || addresses.length === 0) return addresses;

  try {
    const cutoff = new Date(Date.now() - STALE_AFTER_DAYS * 86_400_000);
    const fresh = await db
      .select({ address: wallets.address })
      .from(wallets)
      .where(
        and(
          eq(wallets.chain, chain),
          inArray(wallets.address, addresses),
          isNotNull(wallets.lifetimePnlUsd),
          gt(wallets.lifetimeUpdatedAt, cutoff)
        )
      );

    const skip = new Set(fresh.map((r) => r.address));
    return addresses.filter((a) => !skip.has(a));
  } catch (err) {
    console.error("[filterNeedsEnrichment] failed:", err);
    return addresses;
  }
}
