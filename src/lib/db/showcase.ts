import "server-only";
import { and, desc, eq, gt, inArray, isNotNull, sql } from "drizzle-orm";
import { getDb } from "./index";
import { tokens, walletTokens, wallets } from "./schema";
import type { Chain, TokenMeta, WalletTrader } from "../types";

/** A token we've already scanned, offered as a free sample. */
export interface ShowcaseToken {
  chain: Chain;
  address: string;
  symbol: string;
  name: string;
  imageUrl: string | null;
  walletCount: number;
}

/** One row of the public "wallets we've tracked" ticker. */
export interface TickerWallet {
  /** Already masked (`abcd…wxyz`). The full address is the paid product and is
   * never sent to this public endpoint. */
  address: string;
  chain: Chain;
  symbol: string;
  boughtUsd: number;
  boughtNative: number | null;
  nativeSymbol: string;
  avgBuyMcapUsd: number;
  avgSellMcapUsd: number;
  multipleX: number;
  roiPercent: number;
  realizedPnlUsd: number;
  /** Null when the scan predates position tracking, so the UI can stay silent
   * rather than claim a wallet fully exited. */
  remainingPercent: number | null;
  unrealizedPnlUsd: number | null;
  timesSeen: number;
  tags: string[];
  /** Other tokens this wallet also won on — the "cards they collected". */
  alsoWon: Array<{ symbol: string; multipleX: number | null; realizedPnlUsd: number }>;
}

const NATIVE_SYMBOL: Record<Chain, string> = {
  solana: "SOL",
  bsc: "BNB",
  base: "ETH",
  robinhood: "ETH",
};

/** Smallest cost basis that still makes a multiple worth showing publicly. */
const MIN_TICKER_BOUGHT_USD = 1000;

/** Keeps the ticker looking real without giving away a scannable address. */
function maskAddress(address: string): string {
  return address.length <= 10 ? address : `${address.slice(0, 4)}…${address.slice(-4)}`;
}

/**
 * Free sample scans. Explicitly curated via the `showcase` flag — a token a
 * customer paid to scan must never become a free sample for everyone else, so
 * this is opt-in per token rather than "anything we happen to have cached".
 */
export async function fetchShowcaseTokens(limit = 6): Promise<ShowcaseToken[]> {
  const db = getDb();
  if (!db) return [];

  const rows = await db
    .select({
      chain: tokens.chain,
      address: tokens.address,
      symbol: tokens.symbol,
      name: tokens.name,
      imageUrl: tokens.imageUrl,
      walletCount: sql<number>`count(${walletTokens.walletId})::int`,
    })
    .from(tokens)
    .innerJoin(walletTokens, eq(walletTokens.tokenId, tokens.id))
    .where(eq(tokens.showcase, true))
    .groupBy(tokens.id)
    .having(sql`count(${walletTokens.walletId}) >= 20`)
    .orderBy(desc(sql`count(${walletTokens.walletId})`))
    .limit(limit);

  return rows.map((r) => ({
    chain: r.chain as Chain,
    address: r.address,
    symbol: r.symbol ?? "?",
    name: r.name ?? r.symbol ?? "Unknown token",
    imageUrl: r.imageUrl,
    walletCount: Number(r.walletCount),
  }));
}

/**
 * Authoritative "is this token a free sample?" check. Separate from
 * `fetchShowcaseTokens` because that one is display-limited — curating a 7th
 * token would otherwise leave it unreachable behind the list's `limit`.
 */
export async function isShowcaseToken(chain: Chain, address: string): Promise<string | null> {
  const db = getDb();
  if (!db) return null;

  const [row] = await db
    .select({ address: tokens.address })
    .from(tokens)
    .where(
      and(
        eq(tokens.chain, chain),
        eq(tokens.showcase, true),
        sql`lower(${tokens.address}) = lower(${address})`
      )
    )
    .limit(1);

  return row?.address ?? null;
}

/** Recovers a token count from its USD total and average unit price. */
function tokenAmount(usd: number | null, avgPriceUsd: number | null): number {
  if (!usd || !avgPriceUsd || avgPriceUsd <= 0) return 0;
  return usd / avgPriceUsd;
}

/**
 * Replays a stored scan straight from the database. No upstream API call, so a
 * free preview costs nothing per view no matter how often it's opened.
 */
export async function fetchCachedScan(
  chain: Chain,
  address: string,
  limit: number
): Promise<{ token: TokenMeta; traders: WalletTrader[] } | null> {
  const db = getDb();
  if (!db) return null;

  const [tokenRow] = await db
    .select()
    .from(tokens)
    .where(and(eq(tokens.chain, chain), eq(tokens.address, address)))
    .limit(1);
  if (!tokenRow) return null;

  const rows = await db
    .select({
      address: wallets.address,
      nickname: wallets.identityName,
      twitter: wallets.twitter,
      tags: wallets.tags,
      lifetimePnlUsd: wallets.lifetimePnlUsd,
      lifetimeTrades: wallets.lifetimeTrades,
      lifetimeTokensTraded: wallets.lifetimeTokensTraded,
      realizedPnlUsd: walletTokens.realizedPnlUsd,
      roiPercent: walletTokens.roiPercent,
      multipleX: walletTokens.multipleX,
      avgBuyPriceUsd: walletTokens.avgBuyPriceUsd,
      avgSellPriceUsd: walletTokens.avgSellPriceUsd,
      avgBuyMcapUsd: walletTokens.avgBuyMcapUsd,
      avgSellMcapUsd: walletTokens.avgSellMcapUsd,
      boughtUsd: walletTokens.boughtUsd,
      proceedsUsd: walletTokens.proceedsUsd,
      remainingPercent: walletTokens.remainingPercent,
      remainingValueUsd: walletTokens.remainingValueUsd,
      unrealizedPnlUsd: walletTokens.unrealizedPnlUsd,
      lastTradeMs: walletTokens.lastTradeMs,
    })
    .from(walletTokens)
    .innerJoin(wallets, eq(wallets.id, walletTokens.walletId))
    .where(eq(walletTokens.tokenId, tokenRow.id))
    .orderBy(desc(walletTokens.realizedPnlUsd))
    .limit(limit);

  if (rows.length === 0) return null;

  const token: TokenMeta = {
    chain,
    address: tokenRow.address,
    name: tokenRow.name ?? tokenRow.symbol ?? "Unknown token",
    symbol: tokenRow.symbol ?? "?",
    imageUrl: tokenRow.imageUrl,
    priceUsd: tokenRow.priceUsd ?? 0,
    marketCapUsd: tokenRow.marketCapUsd ?? 0,
    // Reconstructed from the stored snapshot; a 0 here would zero every market
    // cap in the wallet detail panel this token opens.
    estimatedSupply:
      tokenRow.priceUsd && tokenRow.priceUsd > 0
        ? (tokenRow.marketCapUsd ?? 0) / tokenRow.priceUsd
        : 0,
    nativePriceUsd: tokenRow.nativePriceUsd ?? 0,
    isToken2022: false,
    source: "other",
    market: null,
    rankingWindow: chain === "solana" ? "all_time" : "90d",
  };

  const traders: WalletTrader[] = rows.map((r, i) => ({
    rank: i + 1,
    address: r.address,
    nickname: r.nickname,
    twitter: r.twitter,
    tags: r.tags ?? [],
    avgBuyPriceUsd: r.avgBuyPriceUsd ?? 0,
    avgSellPriceUsd: r.avgSellPriceUsd ?? 0,
    avgBuyMcapUsd: r.avgBuyMcapUsd ?? 0,
    avgSellMcapUsd: r.avgSellMcapUsd ?? 0,
    buyTxns: 0,
    sellTxns: 0,
    // Token counts aren't stored, but the avg prices were derived as USD/tokens
    // upstream, so dividing back out returns the original amounts exactly.
    boughtTokenAmount: tokenAmount(r.boughtUsd, r.avgBuyPriceUsd),
    soldTokenAmount: tokenAmount(r.proceedsUsd, r.avgSellPriceUsd),
    // Not stored, and not derivable without the live balance this scan saw.
    transferredOutPercent: null,
    boughtUsd: r.boughtUsd ?? 0,
    soldUsd: r.proceedsUsd ?? 0,
    // Recovered from the stored averages: cost of the tokens that were sold.
    // Clamped to tokens bought exactly as the live path does — wallets that
    // received transfers can sell more than they bought, and without the clamp a
    // cached preview reports a bigger basis than a paid scan of the same wallet.
    soldCostBasisUsd:
      Math.min(
        tokenAmount(r.proceedsUsd, r.avgSellPriceUsd),
        tokenAmount(r.boughtUsd, r.avgBuyPriceUsd)
      ) * (r.avgBuyPriceUsd ?? 0),
    realizedPnlUsd: r.realizedPnlUsd,
    realizedPnlPercent: r.roiPercent ?? 0,
    avgMultipleX: r.multipleX ?? 0,
    remainingPercent: r.remainingPercent,
    remainingValueUsd: r.remainingValueUsd,
    isHolding: r.remainingPercent === null ? null : r.remainingPercent > 0,
    unrealizedPnlUsd: r.unrealizedPnlUsd,
    lastTradeMs: r.lastTradeMs ?? null,
    firstTradeMs: null,
    walletLifetimeRealizedPnlUsd: r.lifetimePnlUsd,
    walletLifetimeTotalTrades: r.lifetimeTrades,
    walletLifetimeTokensTraded: r.lifetimeTokensTraded,
  }));

  return { token, traders };
}

/** No single token may fill more than this many ticker slots, so one heavily
 * re-scanned coin can never crowd out every other one — this is what actually
 * keeps the ticker showing wallets from different tokens. */
const MAX_PER_SYMBOL = 3;

/**
 * Wallets for the homepage ticker. Only rows with every displayed field present
 * are returned, so the animation never renders a blank or invented figure.
 */
export async function fetchTickerWallets(limit = 40): Promise<TickerWallet[]> {
  const db = getDb();
  if (!db) return [];

  const rows = await db
    .select({
      address: wallets.address,
      chain: wallets.chain,
      tags: wallets.tags,
      timesSeen: wallets.timesSeen,
      walletId: wallets.id,
      symbol: tokens.symbol,
      nativePriceUsd: tokens.nativePriceUsd,
      realizedPnlUsd: walletTokens.realizedPnlUsd,
      roiPercent: walletTokens.roiPercent,
      multipleX: walletTokens.multipleX,
      avgBuyMcapUsd: walletTokens.avgBuyMcapUsd,
      avgSellMcapUsd: walletTokens.avgSellMcapUsd,
      boughtUsd: walletTokens.boughtUsd,
      remainingPercent: walletTokens.remainingPercent,
      unrealizedPnlUsd: walletTokens.unrealizedPnlUsd,
    })
    .from(walletTokens)
    .innerJoin(wallets, eq(wallets.id, walletTokens.walletId))
    .innerJoin(tokens, eq(tokens.id, walletTokens.tokenId))
    .where(
      and(
        eq(wallets.isBot, false),
        gt(walletTokens.realizedPnlUsd, 0),
        // Below a real cost basis the multiple stops meaning anything: airdropped
        // and transferred-in supply produced a "184838x" Pnut row off $16 spent.
        gt(walletTokens.boughtUsd, MIN_TICKER_BOUGHT_USD),
        isNotNull(walletTokens.avgBuyMcapUsd),
        isNotNull(walletTokens.avgSellMcapUsd),
        isNotNull(walletTokens.multipleX),
        isNotNull(walletTokens.boughtUsd),
        isNotNull(walletTokens.roiPercent)
      )
    )
    // Recency first — the ticker is meant to showcase what we've *just*
    // added, not the same all-time-best rows forever.
    .orderBy(desc(walletTokens.firstObservedAt))
    .limit(Math.max(limit * 5, 150));

  if (rows.length === 0) return [];

  // One extra query for every wallet's other wins, rather than N per row.
  const ids = rows.map((r) => r.walletId);
  const otherWins = await db
    .select({
      walletId: walletTokens.walletId,
      symbol: tokens.symbol,
      multipleX: walletTokens.multipleX,
      realizedPnlUsd: walletTokens.realizedPnlUsd,
    })
    .from(walletTokens)
    .innerJoin(tokens, eq(tokens.id, walletTokens.tokenId))
    .where(
      and(
        inArray(walletTokens.walletId, ids),
        gt(walletTokens.realizedPnlUsd, 0),
        // Same cost-basis floor as the headline row above; without it a dust-basis
        // multiple that is too absurd to headline still renders as a chip.
        gt(walletTokens.boughtUsd, MIN_TICKER_BOUGHT_USD),
        isNotNull(walletTokens.multipleX)
      )
    )
    .orderBy(desc(walletTokens.realizedPnlUsd));

  const winsByWallet = new Map<number, TickerWallet["alsoWon"]>();
  for (const w of otherWins) {
    const list = winsByWallet.get(w.walletId) ?? [];
    list.push({
      symbol: w.symbol ?? "?",
      multipleX: w.multipleX,
      realizedPnlUsd: w.realizedPnlUsd,
    });
    winsByWallet.set(w.walletId, list);
  }

  return capPerSymbol(
    rows.map((r) => {
      const chain = r.chain as Chain;
      const bought = r.boughtUsd ?? 0;
      return {
        address: maskAddress(r.address),
        chain,
        symbol: r.symbol ?? "?",
        boughtUsd: bought,
        boughtNative: r.nativePriceUsd ? bought / r.nativePriceUsd : null,
        nativeSymbol: NATIVE_SYMBOL[chain] ?? "SOL",
        avgBuyMcapUsd: r.avgBuyMcapUsd ?? 0,
        avgSellMcapUsd: r.avgSellMcapUsd ?? 0,
        multipleX: r.multipleX ?? 0,
        roiPercent: r.roiPercent ?? 0,
        realizedPnlUsd: r.realizedPnlUsd,
        remainingPercent: r.remainingPercent,
        unrealizedPnlUsd: r.unrealizedPnlUsd,
        timesSeen: r.timesSeen,
        tags: r.tags ?? [],
        alsoWon: (winsByWallet.get(r.walletId) ?? [])
          .filter((w) => w.symbol !== r.symbol)
          .slice(0, 4),
      };
    }),
    MAX_PER_SYMBOL,
    limit
  );
}

/** Keeps the highest-PNL rows but caps how many any one symbol contributes,
 * preserving the overall PNL ordering otherwise. */
function capPerSymbol(rows: TickerWallet[], maxPerSymbol: number, limit: number): TickerWallet[] {
  const counts = new Map<string, number>();
  const capped: TickerWallet[] = [];
  for (const row of rows) {
    const count = counts.get(row.symbol) ?? 0;
    if (count >= maxPerSymbol) continue;
    counts.set(row.symbol, count + 1);
    capped.push(row);
    if (capped.length >= limit) break;
  }
  return capped;
}

/** Totals for the ticker header. */
export async function fetchShowcaseStats(): Promise<{
  wallets: number;
  tokens: number;
  totalPnlUsd: number;
}> {
  const db = getDb();
  if (!db) return { wallets: 0, tokens: 0, totalPnlUsd: 0 };

  const [row] = await db
    .select({
      wallets: sql<number>`count(distinct ${walletTokens.walletId})::int`,
      tokens: sql<number>`count(distinct ${walletTokens.tokenId})::int`,
      totalPnlUsd: sql<number>`coalesce(sum(greatest(${walletTokens.realizedPnlUsd}, 0)), 0)::float8`,
    })
    .from(walletTokens);

  return {
    wallets: Number(row?.wallets ?? 0),
    tokens: Number(row?.tokens ?? 0),
    totalPnlUsd: Number(row?.totalPnlUsd ?? 0),
  };
}
