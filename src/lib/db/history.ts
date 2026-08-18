import "server-only";
import { and, eq, gt, inArray, ne, sql } from "drizzle-orm";
import { getDb } from "./index";
import { tokens, walletTokens, wallets } from "./schema";
import type { Chain, WalletHistory } from "../types";

function emptyHistory(): WalletHistory {
  return { priorTokenCount: 0, lifetimePnlUsd: null, isBot: false, wins: [], winBadges: [] };
}

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
          // EVM addresses vary in case between checksummed and lowercase forms,
          // so a raw `ne` can fail to exclude the token being scanned and every
          // wallet picks up a history badge citing the page it is already on.
          // Base58 is case-sensitive, so Solana keeps the exact comparison.
          chain === "solana"
            ? ne(tokens.address, currentTokenAddress)
            : sql`lower(${tokens.address}) <> lower(${currentTokenAddress})`,
          // The badge is a track record, not an appearance counter.
          gt(walletTokens.realizedPnlUsd, 0)
        )
      )
      .orderBy(sql`${walletTokens.realizedPnlUsd} desc`);

    const byAddress: Record<string, WalletHistory> = {};
    for (const r of rows) {
      const entry = (byAddress[r.address] ??= emptyHistory());
      entry.lifetimePnlUsd = r.lifetimePnlUsd ?? entry.lifetimePnlUsd;
      entry.isBot = r.isBot;
      entry.priorTokenCount++;
      if (entry.wins.length < 5) {
        entry.wins.push({
          symbol: r.symbol ?? r.tokenAddress.slice(0, 4),
          realizedPnlUsd: r.realizedPnlUsd,
          multipleX: r.multipleX,
        });
      }
    }

    // Badges cover tokens nobody paid to scan here, so a wallet can have these
    // and no `wins` at all.
    const badgeRows = await db
      .select({
        address: wallets.address,
        winBadges: wallets.winBadges,
        lifetimePnlUsd: wallets.lifetimePnlUsd,
        isBot: wallets.isBot,
      })
      .from(wallets)
      .where(and(eq(wallets.chain, chain), inArray(wallets.address, addresses)));

    for (const r of badgeRows) {
      if (r.winBadges.length === 0) continue;
      const entry = (byAddress[r.address] ??= emptyHistory());
      entry.lifetimePnlUsd = r.lifetimePnlUsd ?? entry.lifetimePnlUsd;
      entry.isBot = r.isBot;
      entry.winBadges = r.winBadges;
    }

    return byAddress;
  } catch {
    // History is a bonus signal; a DB hiccup must never break a scan.
    return {};
  }
}
