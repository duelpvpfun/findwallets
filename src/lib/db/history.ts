import "server-only";
import { and, eq, inArray, ne, sql } from "drizzle-orm";
import { getDb } from "./index";
import { tokens, walletTokens, wallets } from "./schema";
import type { Chain, WalletHistory } from "../types";

/**
 * Looks up prior wins for wallets in the current scan, excluding the token being
 * scanned. Returns {} when no database is configured so callers can ignore it.
 */
export async function fetchWalletHistories(
  chain: Chain,
  currentTokenAddress: string,
  addresses: string[]
): Promise<Record<string, WalletHistory>> {
  const db = getDb();
  if (!db || addresses.length === 0) return {};

  try {
    const rows = await db
      .select({
        address: wallets.address,
        symbol: tokens.symbol,
        tokenAddress: tokens.address,
        realizedPnlUsd: walletTokens.realizedPnlUsd,
        multipleX: walletTokens.multipleX,
        lifetimePnlUsd: wallets.lifetimePnlUsd,
        isBot: wallets.isBot,
      })
      .from(walletTokens)
      .innerJoin(wallets, eq(wallets.id, walletTokens.walletId))
      .innerJoin(tokens, eq(tokens.id, walletTokens.tokenId))
      .where(
        and(
          eq(wallets.chain, chain),
          inArray(wallets.address, addresses),
          ne(tokens.address, currentTokenAddress)
        )
      )
      .orderBy(sql`${walletTokens.realizedPnlUsd} desc`);

    const byAddress: Record<string, WalletHistory> = {};
    for (const r of rows) {
      const entry = (byAddress[r.address] ??= {
        priorTokenCount: 0,
        lifetimePnlUsd: r.lifetimePnlUsd ?? null,
        isBot: r.isBot,
        wins: [],
      });
      entry.priorTokenCount++;
      if (entry.wins.length < 5) {
        entry.wins.push({
          symbol: r.symbol ?? r.tokenAddress.slice(0, 4),
          realizedPnlUsd: r.realizedPnlUsd,
          multipleX: r.multipleX,
        });
      }
    }
    return byAddress;
  } catch {
    // History is a bonus signal; a DB hiccup must never break a scan.
    return {};
  }
}
