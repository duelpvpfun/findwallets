import "server-only";
import { and, eq, inArray, sql } from "drizzle-orm";
import { getDb } from "./index";
import { tokens, walletTokens, wallets } from "./schema";
import { qualityVerdict } from "../quality";
import type { TokenMeta, WalletTrader } from "../types";

const BOT_TAGS = ["arbitrage-bot", "sniper-bot", "bot", "arbitrage"];

// Above this many lifetime trades, upstream's own identity tags are the
// exception, not the rule (232 of ~1000 wallets we've seen sit at 10k-50M
// trades with no bot tag at all) — no human manually trades a token this often.
const BOT_LIFETIME_TRADES_THRESHOLD = 5000;

function looksLikeBot(tags: string[], lifetimeTrades: number | null): boolean {
  if (tags.some((t) => BOT_TAGS.includes(t.toLowerCase()))) return true;
  return (lifetimeTrades ?? 0) >= BOT_LIFETIME_TRADES_THRESHOLD;
}

export interface LifetimeStats {
  address: string;
  pnlUsd: number | null;
  winRate: number | null;
  trades: number | null;
  tokensTraded: number | null;
}

/**
 * Persist one scan, every trader row, win or loss. Safe to call
 * fire-and-forget — never throws into the request path.
 *
 * Overwrite rule: for `all_time` sources (Solana) a rescan is always the newer truth,
 * so we overwrite even when PNL dropped (the wallet round-tripped its unrealized gains).
 * For windowed sources (BSC/Base 90d) an older win can simply fall out of the window,
 * so we only raise the recorded figure and never lower it.
 */
export async function recordScan(
  token: TokenMeta,
  traders: WalletTrader[],
  lifetime: LifetimeStats[] = []
): Promise<void> {
  const db = getDb();
  if (!db || traders.length === 0) return;

  // Postgres rejects ON CONFLICT DO UPDATE when one statement hits the same row
  // twice, and both paginators can hand back a wallet on two pages. Keeping the
  // first copy keeps the better rank, since both feeds are sorted desc by PNL.
  const seenAddress = new Set<string>();
  const uniqueTraders = traders.filter((t) => {
    if (seenAddress.has(t.address)) return false;
    seenAddress.add(t.address);
    return true;
  });
  if (uniqueTraders.length === 0) return;

  // EVERY trader in the scan is stored, losers included, with the quality bar
  // recorded as a column. Filtering here is what made win rate uncomputable:
  // the losses were never written, so a wallet with five stored rows had five
  // wins and an unknown number of losses. This is not recoverable after the
  // fact — backfilling would mean re-paying for every scan already run.
  const verdicts = new Map(
    uniqueTraders.map((t) => [t.address, qualityVerdict(t.avgMultipleX, t.realizedPnlUsd)])
  );

  const isAllTime = token.rankingWindow === "all_time";

  // One unit of work: a crash between these statements would otherwise leave
  // scan_count and times_seen incremented for a scan that stored no rows.
  await db.transaction(async (tx) => {
  const [tokenRow] = await tx
    .insert(tokens)
    .values({
      chain: token.chain,
      address: token.address,
      symbol: token.symbol,
      name: token.name,
      imageUrl: token.imageUrl,
      priceUsd: token.priceUsd,
      marketCapUsd: token.marketCapUsd,
      nativePriceUsd: token.nativePriceUsd,
      estimatedSupply: token.estimatedSupply || null,
      scanCount: 1,
    })
    .onConflictDoUpdate({
      target: [tokens.chain, tokens.address],
      set: {
        symbol: token.symbol,
        name: token.name,
        imageUrl: token.imageUrl,
        priceUsd: token.priceUsd,
        marketCapUsd: token.marketCapUsd,
        nativePriceUsd: token.nativePriceUsd,
        // A failed supply read must not wipe a good stored value.
        estimatedSupply: sql`coalesce(excluded.estimated_supply, ${tokens.estimatedSupply})`,
        lastScannedAt: new Date(),
        scanCount: sql`${tokens.scanCount} + 1`,
      },
    })
    .returning({ id: tokens.id });

  const lifetimeByAddress = new Map(lifetime.map((l) => [l.address, l]));

  await tx
    .insert(wallets)
    .values(
      uniqueTraders.map((t) => {
        const lt = lifetimeByAddress.get(t.address);
        const lifetimeTrades = lt?.trades ?? t.walletLifetimeTotalTrades ?? null;
        return {
          chain: token.chain,
          address: t.address,
          identityName: t.nickname,
          twitter: t.twitter,
          tags: t.tags,
          isBot: looksLikeBot(t.tags, lifetimeTrades),
          lifetimePnlUsd: lt?.pnlUsd ?? t.walletLifetimeRealizedPnlUsd ?? null,
          lifetimeWinRate: lt?.winRate ?? null,
          lifetimeTrades,
          lifetimeTokensTraded: lt?.tokensTraded ?? t.walletLifetimeTokensTraded ?? null,
          lifetimeUpdatedAt: lt ? new Date() : null,
          timesSeen: 1,
        };
      })
    )
    .onConflictDoUpdate({
      target: [wallets.chain, wallets.address],
      set: {
        identityName: sql`coalesce(excluded.identity_name, ${wallets.identityName})`,
        twitter: sql`coalesce(excluded.twitter, ${wallets.twitter})`,
        tags: sql`case when array_length(excluded.tags, 1) > 0 then excluded.tags else ${wallets.tags} end`,
        isBot: sql`${wallets.isBot} or excluded.is_bot`,
        lifetimePnlUsd: sql`coalesce(excluded.lifetime_pnl_usd, ${wallets.lifetimePnlUsd})`,
        lifetimeWinRate: sql`coalesce(excluded.lifetime_win_rate, ${wallets.lifetimeWinRate})`,
        lifetimeTrades: sql`coalesce(excluded.lifetime_trades, ${wallets.lifetimeTrades})`,
        lifetimeTokensTraded: sql`coalesce(excluded.lifetime_tokens_traded, ${wallets.lifetimeTokensTraded})`,
        lifetimeUpdatedAt: sql`coalesce(excluded.lifetime_updated_at, ${wallets.lifetimeUpdatedAt})`,
        lastSeenAt: new Date(),
        timesSeen: sql`${wallets.timesSeen} + 1`,
      },
    });

  const walletRows = await tx
    .select({ id: wallets.id, address: wallets.address })
    .from(wallets)
    .where(
      and(
        eq(wallets.chain, token.chain),
        inArray(
          wallets.address,
          uniqueTraders.map((t) => t.address)
        )
      )
    );
  const idByAddress = new Map(walletRows.map((w) => [w.address, w.id]));

  const rows = uniqueTraders
    .map((t) => {
      const walletId = idByAddress.get(t.address);
      if (!walletId) return null;
      const verdict = verdicts.get(t.address) ?? { qualified: false, reason: "no_multiple" as const };
      return {
        walletId,
        tokenId: tokenRow.id,
        rank: t.rank,
        realizedPnlUsd: t.realizedPnlUsd,
        roiPercent: t.realizedPnlPercent,
        multipleX: t.avgMultipleX,
        avgBuyPriceUsd: t.avgBuyPriceUsd,
        avgSellPriceUsd: t.avgSellPriceUsd,
        avgBuyMcapUsd: t.avgBuyMcapUsd,
        avgSellMcapUsd: t.avgSellMcapUsd,
        boughtUsd: t.boughtUsd,
        proceedsUsd: t.soldUsd,
        remainingPercent: t.remainingPercent,
        remainingValueUsd: t.remainingValueUsd,
        unrealizedPnlUsd: t.unrealizedPnlUsd,
        lastTradeMs: t.lastTradeMs,
        rankingWindow: token.rankingWindow,
        qualified: verdict.qualified,
        disqualifiedReason: verdict.reason,
      };
    })
    .filter((r): r is NonNullable<typeof r> => r !== null);

  if (rows.length === 0) return;

  const pnlUpdate = isAllTime
    ? sql`excluded.realized_pnl_usd`
    : sql`greatest(${walletTokens.realizedPnlUsd}, excluded.realized_pnl_usd)`;
  const keepNewer = isAllTime
    ? sql`true`
    : sql`excluded.realized_pnl_usd > ${walletTokens.realizedPnlUsd}`;

  await tx
    .insert(walletTokens)
    .values(rows.map((r) => ({ ...r, bestRank: r.rank, lastRank: r.rank, timesObserved: 1 })))
    .onConflictDoUpdate({
      target: [walletTokens.walletId, walletTokens.tokenId],
      set: {
        bestRank: sql`least(coalesce(${walletTokens.bestRank}, 2147483647), coalesce(excluded.best_rank, 2147483647))`,
        lastRank: sql`excluded.last_rank`,
        lastTradeMs: sql`greatest(coalesce(${walletTokens.lastTradeMs}, 0), coalesce(excluded.last_trade_ms, 0))`,
        realizedPnlUsd: pnlUpdate,
        roiPercent: sql`case when ${keepNewer} then excluded.roi_percent else ${walletTokens.roiPercent} end`,
        multipleX: sql`case when ${keepNewer} then excluded.multiple_x else ${walletTokens.multipleX} end`,
        avgBuyPriceUsd: sql`case when ${keepNewer} then excluded.avg_buy_price_usd else ${walletTokens.avgBuyPriceUsd} end`,
        avgSellPriceUsd: sql`case when ${keepNewer} then excluded.avg_sell_price_usd else ${walletTokens.avgSellPriceUsd} end`,
        avgBuyMcapUsd: sql`case when ${keepNewer} then excluded.avg_buy_mcap_usd else ${walletTokens.avgBuyMcapUsd} end`,
        avgSellMcapUsd: sql`case when ${keepNewer} then excluded.avg_sell_mcap_usd else ${walletTokens.avgSellMcapUsd} end`,
        boughtUsd: sql`case when ${keepNewer} then excluded.bought_usd else ${walletTokens.boughtUsd} end`,
        proceedsUsd: sql`case when ${keepNewer} then excluded.proceeds_usd else ${walletTokens.proceedsUsd} end`,
        // Position size is only meaningful as of the latest look, so it always
        // takes the newest value rather than following the PNL tie-break.
        remainingPercent: sql`excluded.remaining_percent`,
        remainingValueUsd: sql`excluded.remaining_value_usd`,
        unrealizedPnlUsd: sql`excluded.unrealized_pnl_usd`,
        rankingWindow: sql`excluded.ranking_window`,
        // Tied to the same keep-newer rule as the figures it was derived from.
        // Otherwise a windowed rescan whose win fell out of the 90-day window
        // would leave the row's PNL at the old (higher) figure while flipping
        // `qualified` to false — a row describing a win, labelled a loss.
        qualified: sql`case when ${keepNewer} then excluded.qualified else ${walletTokens.qualified} end`,
        disqualifiedReason: sql`case when ${keepNewer} then excluded.disqualified_reason else ${walletTokens.disqualifiedReason} end`,
        timesObserved: sql`${walletTokens.timesObserved} + 1`,
        lastObservedAt: new Date(),
      },
    });
  });
}
