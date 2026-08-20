import "server-only";
import { and, eq, sql } from "drizzle-orm";
import { getDb } from "./index";
import { tokens } from "./schema";
import type { Chain } from "../types";

/**
 * Supply as recorded by the last scan of this token. Preferred over anything a
 * caller supplies: the client value is attacker-controlled and feeds market-cap
 * math, so a forged one produces wrong-but-plausible numbers.
 */
export async function getStoredSupply(chain: Chain, tokenAddress: string): Promise<number | null> {
  const db = getDb();
  if (!db) return null;
  try {
    const rows = await db
      .select({ estimatedSupply: tokens.estimatedSupply })
      .from(tokens)
      .where(
        and(
          eq(tokens.chain, chain),
          // EVM addresses are stored checksummed but arrive in either case.
          chain === "solana"
            ? eq(tokens.address, tokenAddress)
            : sql`lower(${tokens.address}) = lower(${tokenAddress})`
        )
      )
      .limit(1);
    const supply = rows[0]?.estimatedSupply ?? 0;
    return supply > 0 ? supply : null;
  } catch (err) {
    console.error("[getStoredSupply] failed:", err);
    return null;
  }
}
