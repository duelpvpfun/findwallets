import "server-only";
import { and, eq, inArray, sql } from "drizzle-orm";
import { getDb } from "./index";
import { wallets } from "./schema";
import type { Chain, WalletTrader } from "../types";

/**
 * Fills in the name and X handle for traders we already know by name.
 *
 * Our paid upstreams only attach an identity on Solana, and only sometimes:
 * Birdeye returns none at all, so a BNB Chain or Base row is a bare address even
 * when the wallet belongs to someone with 300k followers. `wallets` holds a
 * curated directory (see `scripts/import-kol-wallets.mjs`), and this is what
 * puts it in front of the buyer.
 *
 * Only gaps are filled. What the provider said about a wallet stands.
 *
 * Best-effort, like every other database read on this path: a hiccup here must
 * never cost someone the scan they paid for, so a failure returns the traders
 * exactly as they came in.
 */
export async function withWalletIdentities(
  chain: Chain,
  traders: WalletTrader[]
): Promise<WalletTrader[]> {
  const db = getDb();
  if (!db || traders.length === 0) return traders;

  // Nothing to look up when the provider already named everyone.
  const unnamed = traders.filter((t) => !t.nickname || !t.twitter);
  if (unnamed.length === 0) return traders;

  try {
    // EVM addresses reach us checksummed from Birdeye and are stored lowercased,
    // so an exact match would find nothing at all. Base58 is case-sensitive, so
    // Solana keeps the exact comparison (and its index).
    const isEvm = chain !== "solana";
    const lookup = unnamed.map((t) => (isEvm ? t.address.toLowerCase() : t.address));

    const rows = await db
      .select({
        address: wallets.address,
        identityName: wallets.identityName,
        twitter: wallets.twitter,
      })
      .from(wallets)
      .where(
        and(
          eq(wallets.chain, chain),
          isEvm
            ? inArray(sql`lower(${wallets.address})`, lookup)
            : inArray(wallets.address, lookup)
        )
      );
    if (rows.length === 0) return traders;

    const byKey = new Map(
      rows
        .filter((r) => r.identityName || r.twitter)
        .map((r) => [isEvm ? r.address.toLowerCase() : r.address, r])
    );
    if (byKey.size === 0) return traders;

    return traders.map((t) => {
      const known = byKey.get(isEvm ? t.address.toLowerCase() : t.address);
      if (!known) return t;
      return {
        ...t,
        nickname: t.nickname ?? known.identityName,
        twitter: t.twitter ?? known.twitter,
      };
    });
  } catch {
    return traders;
  }
}
