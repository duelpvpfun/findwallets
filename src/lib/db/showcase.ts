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
  investedUsd: number;
  investedNative: number | null;
  nativeSymbol: string;
  avgBuyMcapUsd: number;
  avgSellMcapUsd: number;
  multipleX: number;
  roiPercent: number;
  realizedPnlUsd: number;
  timesSeen: number;
  tags: string[];
  /** Other tokens this wallet also won on — the "cards they collected". */
  alsoWon: Array<{ symbol: string; multipleX: number | null; realizedPnlUsd: number }>;
}

const NATIVE_SYMBOL: Record<Chain, string> = { solana: "SOL", bsc: "BNB", base: "ETH" };

/** Smallest cost basis that still makes a multiple worth showing publicly. */
const MIN_TICKER_INVESTED_USD = 1000;

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
      investedUsd: walletTokens.investedUsd,
      proceedsUsd: walletTokens.proceedsUsd,
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
    boughtTokenAmount: 0,
    soldTokenAmount: 0,
    boughtUsd: r.investedUsd ?? 0,
    soldUsd: r.proceedsUsd ?? 0,
    realizedPnlUsd: r.realizedPnlUsd,
    realizedPnlPercent: r.roiPercent ?? 0,
    avgMultipleX: r.multipleX ?? 0,
    remainingPercent: null,
    remainingValueUsd: null,
    isHolding: null,
    lastTradeMs: r.lastTradeMs ?? null,
    firstTradeMs: null,
    walletLifetimeRealizedPnlUsd: r.lifetimePnlUsd,
    walletLifetimeTotalTrades: r.lifetimeTrades,
    walletLifetimeTokensTraded: r.lifetimeTokensTraded,
  }));

  return { token, traders };
}

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
      investedUsd: walletTokens.investedUsd,
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
        gt(walletTokens.investedUsd, MIN_TICKER_INVESTED_USD),
        isNotNull(walletTokens.avgBuyMcapUsd),
        isNotNull(walletTokens.avgSellMcapUsd),
        isNotNull(walletTokens.multipleX),
        isNotNull(walletTokens.investedUsd),
        isNotNull(walletTokens.roiPercent)
      )
    )
    .orderBy(desc(walletTokens.realizedPnlUsd))
    .limit(limit);

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
        gt(walletTokens.investedUsd, MIN_TICKER_INVESTED_USD),
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

  return rows.map((r) => {
    const chain = r.chain as Chain;
    const invested = r.investedUsd ?? 0;
    return {
      address: maskAddress(r.address),
      chain,
      symbol: r.symbol ?? "?",
      investedUsd: invested,
      investedNative: r.nativePriceUsd ? invested / r.nativePriceUsd : null,
      nativeSymbol: NATIVE_SYMBOL[chain] ?? "SOL",
      avgBuyMcapUsd: r.avgBuyMcapUsd ?? 0,
      avgSellMcapUsd: r.avgSellMcapUsd ?? 0,
      multipleX: r.multipleX ?? 0,
      roiPercent: r.roiPercent ?? 0,
      realizedPnlUsd: r.realizedPnlUsd,
      timesSeen: r.timesSeen,
      tags: r.tags ?? [],
      alsoWon: (winsByWallet.get(r.walletId) ?? [])
        .filter((w) => w.symbol !== r.symbol)
        .slice(0, 4),
    };
  });
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
