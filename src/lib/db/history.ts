import "server-only";
import { and, eq, inArray, sql } from "drizzle-orm";
import { getDb } from "./index";
import { wallets } from "./schema";
import type { Chain, WalletHistory } from "../types";

function emptyHistory(): WalletHistory {
  return {
    priorTokenCount: 0,
    priorTradeCount: 0,
    lifetimePnlUsd: null,
    isBot: false,
    wins: [],
    winBadges: [],
  };
}

/**
 * Looks up prior trades for wallets in the current scan, excluding the token
 * being scanned. Returns {} when no database is configured so callers can
 * ignore it.
 *
 * Two counts, not one. `priorTokenCount` is wins — rows clearing the quality
 * bar — and is what the badge claims. `priorTradeCount` is every trade we hold,
 * wins and losses, which is the only honest denominator for a win rate. Before
 * losing trades were stored the two were identical by construction and the
 * ratio was always 100%.
 */
export async function fetchWalletHistories(
  chain: Chain,
  currentTokenAddress: string,
  addresses: string[]
): Promise<Record<string, WalletHistory>> {
  const db = getDb();
  if (!db || addresses.length === 0) return {};

  try {
    // EVM addresses vary in case between checksummed and lowercase forms, so a
    // raw `<>` can fail to exclude the token being scanned and every wallet
    // picks up a history badge citing the page it is already on. Base58 is
    // case-sensitive, so Solana keeps the exact comparison.
    const excludeCurrent =
      chain === "solana"
        ? sql`t.address <> ${currentTokenAddress}`
        : sql`lower(t.address) <> lower(${currentTokenAddress})`;

    // The count and the top 5 are computed in SQL. Selecting every qualifying
    // wallet_tokens row for 500 wallets and slicing in JS meant pulling
    // hundreds of thousands of rows over the wire on every paid scan.
    const rows = await db.execute<{
      address: string;
      priorTokenCount: number;
      priorTradeCount: number;
      lifetimePnlUsd: number | null;
      isBot: boolean;
      wins: Array<{ symbol: string | null; tokenAddress: string; realizedPnlUsd: number; multipleX: number | null }>;
    }>(sql`
      with scanned as (
        select ${wallets.id} as wallet_id,
               ${wallets.address} as address,
               ${wallets.lifetimePnlUsd} as lifetime_pnl_usd,
               ${wallets.isBot} as is_bot
        from ${wallets}
        where ${and(eq(wallets.chain, chain), inArray(wallets.address, addresses))}
      ),
      tallied as (
        select s.wallet_id,
               count(*) filter (where wt.qualified)::int as prior_token_count,
               count(*)::int as prior_trade_count
        from scanned s
        join wallet_tokens wt on wt.wallet_id = s.wallet_id
        join tokens t on t.id = wt.token_id
        where ${excludeCurrent}
        group by s.wallet_id
      )
      select
        s.address,
        coalesce(q.prior_token_count, 0) as "priorTokenCount",
        coalesce(q.prior_trade_count, 0) as "priorTradeCount",
        s.lifetime_pnl_usd as "lifetimePnlUsd",
        s.is_bot as "isBot",
        coalesce(w.wins, '[]'::json) as wins
      from scanned s
      left join tallied q on q.wallet_id = s.wallet_id
      left join lateral (
        select json_agg(
                 json_build_object(
                   'symbol', top.symbol,
                   'tokenAddress', top.address,
                   'realizedPnlUsd', top.realized_pnl_usd,
                   'multipleX', top.multiple_x
                 ) order by top.realized_pnl_usd desc
               ) as wins
        from (
          select t.symbol, t.address, wt.realized_pnl_usd, wt.multiple_x
          from wallet_tokens wt
          join tokens t on t.id = wt.token_id
          where wt.wallet_id = s.wallet_id
            -- Only wins get a badge. A positive PNL used to be enough, because
            -- nothing below the bar was ever stored; now a $500 / 1.4x trade is
            -- in the table and would otherwise be badged as a win.
            and wt.qualified
            and ${excludeCurrent}
          order by wt.realized_pnl_usd desc
          limit 5
        ) top
      ) w on true
      where q.wallet_id is not null`);

    const byAddress: Record<string, WalletHistory> = {};
    for (const r of rows) {
      const entry = (byAddress[r.address] ??= emptyHistory());
      entry.lifetimePnlUsd = r.lifetimePnlUsd ?? entry.lifetimePnlUsd;
      entry.isBot = r.isBot;
      entry.priorTokenCount = r.priorTokenCount;
      entry.priorTradeCount = r.priorTradeCount;
      entry.wins = (r.wins ?? []).map((w) => ({
        symbol: w.symbol ?? w.tokenAddress.slice(0, 4),
        realizedPnlUsd: w.realizedPnlUsd,
        multipleX: w.multipleX,
      }));
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
