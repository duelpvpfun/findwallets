// Server-only client for the Birdeye Data API (https://docs.birdeye.so) — used
// for chains other than Solana (BSC, Base, etc). Never import from "use client".
//
// IMPORTANT differences vs Solana Tracker (see /memories/repo/birdeye-bsc-api.md):
// - Top-traders `limit` is hard-capped at 10 per request (not 200), so fetching
//   100-500 wallets means many paginated calls (batched with limited concurrency).
// - `time_frame=all_time` is Solana-only; non-Solana chains max out at "90d" — the
//   ranking is NOT lifetime, only within the selected window.
// - No wallet-balance / portfolio endpoints exist for non-Solana chains, so the
//   wallet-detail view has less data than the Solana version (no SOL/BNB balance,
//   no "wallet value" figure).
import "server-only";
import type { Chain, TokenMeta, WalletDetail, WalletTrader } from "./types";
import { fetchTokenBalances, fetchTokenDecimals } from "./evmBalances";
import { displayMultiple, realizedBasisUsd } from "./quality";

const BASE_URL = "https://public-api.birdeye.so";

export type EvmChain = Extract<Chain, "bsc" | "base">;

export class BirdeyeError extends Error {
  constructor(message: string, public status?: number) {
    super(message);
  }
}

function apiKey(): string {
  const key = process.env.BIRDEYE_API_KEY;
  if (!key) {
    throw new BirdeyeError("BIRDEYE_API_KEY is not configured.");
  }
  return key;
}

// Birdeye Lite tier allows 15 req/sec account-wide. Stay under it with a simple
// token-bucket gate so a 500-wallet fetch (50 paginated calls) can't burst into 429s.
const MAX_RPS = 10;
const requestTimes: number[] = [];

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function acquireRateLimitSlot(): Promise<void> {
  for (;;) {
    const now = Date.now();
    while (requestTimes.length > 0 && now - requestTimes[0] >= 1000) requestTimes.shift();
    if (requestTimes.length < MAX_RPS) {
      requestTimes.push(now);
      return;
    }
    await sleep(1000 - (now - requestTimes[0]) + 20);
  }
}

async function beFetch<T>(
  chain: EvmChain,
  path: string,
  params?: Record<string, string | number | undefined>,
  jsonBody?: unknown
): Promise<T> {
  const url = new URL(path, BASE_URL);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
  }

  const MAX_ATTEMPTS = 4;
  for (let attempt = 1; ; attempt++) {
    await acquireRateLimitSlot();
    const res = await fetch(url, {
      method: jsonBody ? "POST" : "GET",
      headers: {
        "X-API-KEY": apiKey(),
        "x-chain": chain,
        ...(jsonBody ? { "Content-Type": "application/json" } : {}),
      },
      body: jsonBody ? JSON.stringify(jsonBody) : undefined,
      cache: "no-store",
    });
    const body = await res.json().catch(() => null);

    if (res.status === 429 && attempt < MAX_ATTEMPTS) {
      await sleep(500 * 2 ** (attempt - 1));
      continue;
    }
    if (!res.ok || body?.success === false) {
      const message =
        res.status === 429
          ? "Birdeye rate limit reached. Try a smaller wallet count or wait a moment."
          : body?.message ?? `Birdeye request failed (${res.status})`;
      throw new BirdeyeError(message, res.status);
    }
    return body.data as T;
  }
}

export function isBirdeyeConfigured(): boolean {
  return Boolean(process.env.BIRDEYE_API_KEY);
}

// Wrapped native coin addresses, used for native/USD price lookups.
const NATIVE_WRAPPED: Record<EvmChain, string> = {
  bsc: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c", // WBNB
  base: "0x4200000000000000000000000000000000000006", // WETH on Base
};

interface PriceResponse {
  value: number;
}

export async function fetchNativePriceUsd(chain: EvmChain): Promise<number> {
  const data = await beFetch<PriceResponse>(chain, "/defi/price", { address: NATIVE_WRAPPED[chain] });
  return data.value ?? 0;
}

// --- Token metadata ---

interface TokenMetadataResponse {
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  extensions?: { twitter?: string; website?: string };
  logo_uri?: string;
}

interface TokenMarketDataResponse {
  price: number;
  liquidity: number;
  total_supply: number;
  circulating_supply: number;
  market_cap: number;
}

export async function fetchEvmTokenMeta(chain: EvmChain, address: string): Promise<TokenMeta> {
  const [meta, market, nativePriceUsd] = await Promise.all([
    beFetch<TokenMetadataResponse>(chain, "/defi/v3/token/meta-data/single", { address }),
    beFetch<TokenMarketDataResponse>(chain, "/defi/v3/token/market-data", { address }),
    fetchNativePriceUsd(chain),
  ]);

  const priceUsd = market.price ?? 0;
  const marketCapUsd = market.market_cap ?? 0;
  // `||`, not `??`: Birdeye reports 0 (not null) for unindexed circulating
  // supply, and a 0 here zeroes every market cap in the scan.
  const estimatedSupply = market.circulating_supply || market.total_supply || 0;

  return {
    chain,
    address,
    name: meta.name,
    symbol: meta.symbol,
    imageUrl: meta.logo_uri ?? null,
    priceUsd,
    marketCapUsd,
    estimatedSupply,
    nativePriceUsd,
    isToken2022: false,
    source: "other",
    market: null,
    rankingWindow: "90d",
  };
}

// --- Top traders ---
// Birdeye's per-chain "sort by realized PnL over a window" is the closest analog
// to Solana Tracker's all-time ranking, but capped at a 90-day lookback window
// and 10 results per page (see module doc comment above).

interface TopTraderItem {
  owner: string;
  tags: string[];
  trade: number;
  tradeBuy: number;
  tradeSell: number;
  volumeBuy: number;
  volumeSell: number;
  volumeBuyUSD: number;
  volumeSellUSD: number;
  totalPnl: number;
  unrealizedPnl: number;
  realizedPnl: number;
}

interface TopTradersResponse {
  items: TopTraderItem[];
}

/**
 * Birdeye reports `counts.win_rate` as a RATIO (confirmed live: 0.1234 for a
 * 12.3% wallet), while SolanaTracker's `analysis.winRate` is already a percent
 * (21.53). Both land in the same column, so this normalises to percent.
 */
function toWinRatePercent(winRate: number | null | undefined): number | null {
  if (winRate === null || winRate === undefined || !Number.isFinite(winRate)) return null;
  return winRate * 100;
}

function mapTopTrader(item: TopTraderItem, rank: number, estimatedSupply: number): WalletTrader {
  const avgBuyPriceUsd = item.volumeBuy > 0 ? item.volumeBuyUSD / item.volumeBuy : 0;
  const avgSellPriceUsd = item.volumeSell > 0 ? item.volumeSellUSD / item.volumeSell : 0;
  const boughtUsd = item.volumeBuyUSD;
  const soldUsd = item.volumeSellUSD;
  // Only the tokens that were actually sold can have a realized return. Charging
  // the whole buy volume made a wallet that sold 4% of its bag at 2.4x read as
  // 1.06x, contradicting the Entry -> Exit prices on the same row.
  const soldCostBasisUsd = Math.min(item.volumeSell, item.volumeBuy) * avgBuyPriceUsd;
  const realizedBasis = realizedBasisUsd(soldCostBasisUsd, boughtUsd);
  const multiple = displayMultiple(item.realizedPnl, realizedBasis);
  const realizedPnlPercent = multiple === null ? 0 : (multiple - 1) * 100;

  return {
    rank,
    address: item.owner,
    nickname: null,
    twitter: null,
    tags: item.tags ?? [],
    avgBuyPriceUsd,
    avgSellPriceUsd,
    avgBuyMcapUsd: avgBuyPriceUsd * estimatedSupply,
    avgSellMcapUsd: avgSellPriceUsd * estimatedSupply,
    buyTxns: item.tradeBuy,
    sellTxns: item.tradeSell,
    boughtTokenAmount: item.volumeBuy,
    soldTokenAmount: item.volumeSell,
    // Needs the on-chain balance; applyOnChainHoldings fills it in.
    transferredOutPercent: null,
    boughtUsd,
    soldUsd,
    soldCostBasisUsd,
    realizedPnlUsd: item.realizedPnl,
    realizedPnlPercent,
    avgMultipleX: multiple,
    // Deliberately not seeded from item.unrealizedPnl: that figure is derived
    // from buy/sell volume inside the window, so transfers out read as holdings.
    // fetchEvmTopTraders fills these from an on-chain balanceOf instead.
    remainingPercent: null,
    remainingValueUsd: null,
    isHolding: null,
    unrealizedPnlUsd: null,
    lastTradeMs: null,
    firstTradeMs: null,
    walletLifetimeRealizedPnlUsd: null,
    walletLifetimeTotalTrades: null,
    walletLifetimeTokensTraded: null,
  };
}

const PAGE_SIZE = 10; // Hard API limit, confirmed live — see module doc comment.
const MAX_CONCURRENT_PAGES = 10; // Pacing is enforced by acquireRateLimitSlot().

/**
 * Prices each wallet's *actual* on-chain balance, replacing Birdeye's derived
 * unrealized PnL. Wallets whose balance can't be read keep null (unknown)
 * rather than being reported as flat.
 */
async function applyOnChainHoldings(
  chain: EvmChain,
  token: string,
  traders: WalletTrader[],
  priceUsd: number
): Promise<WalletTrader[]> {
  const decimals = await fetchTokenDecimals(chain, token);
  if (decimals === null) return traders;

  const balances = await fetchTokenBalances(
    chain,
    token,
    traders.map((t) => t.address),
    decimals
  );
  if (balances.size === 0) return traders;

  return traders.map((t) => {
    const balance = balances.get(t.address.toLowerCase());
    if (balance === undefined) return t;

    const remainingValueUsd = balance * priceUsd;
    // Cost basis of the unsold tokens, so unrealized PnL is gain — not gross value.
    const costOfRemaining = balance * t.avgBuyPriceUsd;
    // Bought, minus sold, minus what's still there: tokens that left the wallet
    // without a sale. Routine for bundlers splitting a bag across addresses, and
    // the reason a 4%-sold wallet can still show a zero balance.
    const movedOut = t.boughtTokenAmount - t.soldTokenAmount - balance;
    return {
      ...t,
      isHolding: balance > 0,
      remainingPercent:
        t.boughtTokenAmount > 0 ? Math.min(100, (balance / t.boughtTokenAmount) * 100) : 0,
      remainingValueUsd,
      unrealizedPnlUsd: balance > 0 ? remainingValueUsd - costOfRemaining : 0,
      transferredOutPercent:
        t.boughtTokenAmount > 0
          ? Math.min(100, Math.max(0, (movedOut / t.boughtTokenAmount) * 100))
          : null,
    };
  });
}

export async function fetchEvmTopTraders(
  chain: EvmChain,
  address: string,
  limit: number,
  estimatedSupply: number,
  timeFrame: string = "90d",
  priceUsd: number = 0
): Promise<WalletTrader[]> {
  const pageCount = Math.ceil(limit / PAGE_SIZE);
  const traders: WalletTrader[] = [];

  for (let batchStart = 0; batchStart < pageCount; batchStart += MAX_CONCURRENT_PAGES) {
    const batch = Array.from(
      { length: Math.min(MAX_CONCURRENT_PAGES, pageCount - batchStart) },
      (_, i) => batchStart + i
    );
    const pages = await Promise.all(
      batch.map((pageIndex) =>
        beFetch<TopTradersResponse>(chain, "/defi/v2/tokens/top_traders", {
          address,
          time_frame: timeFrame,
          sort_type: "desc",
          sort_by: "realized_pnl",
          offset: pageIndex * PAGE_SIZE,
          limit: PAGE_SIZE,
        })
      )
    );
    let exhausted = false;
    for (const page of pages) {
      // Offset pagination isn't guaranteed dense, so note the gap and keep the
      // later pages in this batch rather than discarding results already paid for.
      if (!page.items || page.items.length === 0) {
        exhausted = true;
        continue;
      }
      page.items.forEach((item) =>
        traders.push(mapTopTrader(item, traders.length + 1, estimatedSupply))
      );
    }
    if (exhausted) break;
  }

  const ranked = traders.slice(0, limit).map((t, i) => ({ ...t, rank: i + 1 }));
  return applyOnChainHoldings(chain, address, ranked, priceUsd);
}

/**
 * Lifetime PNL per wallet. Birdeye has no many-wallets batch equivalent on EVM,
 * so this costs one 35 CU call per wallet — only enrich the top N of a scan.
 */
export async function fetchEvmWalletLifetime(
  chain: EvmChain,
  addresses: string[]
): Promise<Array<{ address: string; pnlUsd: number | null; winRate: number | null; trades: number | null; tokensTraded: number | null }>> {
  const results = await Promise.all(
    addresses.map(async (address) => {
      try {
        const res = await beFetch<WalletPnlSummaryResponse>(chain, "/wallet/v2/pnl/summary", {
          wallet: address,
        });
        return {
          address,
          pnlUsd: res.summary?.pnl?.realized_profit_usd ?? null,
          winRate: toWinRatePercent(res.summary?.counts?.win_rate),
          trades: res.summary?.counts?.total_trade ?? null,
          tokensTraded: null,
        };
      } catch {
        return null;
      }
    })
  );
  return results.filter((r): r is NonNullable<typeof r> => r !== null);
}

// --- Wallet detail (on-demand, single wallet) ---

interface WalletPnlSummaryResponse {
  summary: {
    counts: { total_buy: number; total_sell: number; total_trade: number; total_win: number; total_loss: number; win_rate: number };
    cashflow_usd: { total_invested: number; total_sold: number };
    pnl: {
      realized_profit_usd: number;
      realized_profit_percent: number;
      unrealized_usd: number;
      total_usd: number;
      avg_profit_per_trade_usd: number;
    };
  };
}

interface TokenTxItem {
  tx_hash: string;
  tx_type: "buy" | "sell";
  block_unix_time: number;
  volume_usd: number;
  from: { symbol: string; ui_amount: number; price: number };
  to: { symbol: string; ui_amount: number; price: number };
}

interface TokenTxsResponse {
  items: TokenTxItem[];
  has_next: boolean;
}

interface PnlDetailsToken {
  address: string;
  symbol: string;
  last_trade_unix_time: number | null;
  counts: { total_trade: number };
  cashflow_usd: { total_invested: number; total_sold: number };
  pnl: { realized_profit_usd: number; realized_profit_percent: number };
  pricing: { avg_buy_cost: number; avg_sell_cost: number };
}

interface PnlDetailsResponse {
  tokens: PnlDetailsToken[];
}

export async function fetchEvmWalletDetail(
  chain: EvmChain,
  tokenAddress: string,
  walletAddress: string,
  estimatedSupply: number
): Promise<WalletDetail> {
  const [summary, txs, details] = await Promise.all([
    beFetch<WalletPnlSummaryResponse>(chain, "/wallet/v2/pnl/summary", { wallet: walletAddress }),
    beFetch<TokenTxsResponse>(chain, "/defi/v3/token/txs", {
      address: tokenAddress,
      owner: walletAddress,
      sort_by: "block_unix_time",
      sort_type: "desc",
      limit: 20,
    }),
    beFetch<PnlDetailsResponse>(chain, "/wallet/v2/pnl/details", undefined, {
      wallet: walletAddress,
    }).catch(() => ({ tokens: [] })),
  ]);

  return {
    address: walletAddress,
    twitter: null,
    tags: [],
    // No wallet-portfolio endpoint exists for non-Solana chains via Birdeye.
    totalValueUsd: null,
    nativeBalance: null,
    walletRealizedPnlUsd: summary.summary?.pnl?.realized_profit_usd ?? 0,
    walletUnrealizedPnlUsd: summary.summary?.pnl?.unrealized_usd ?? 0,
    winRatePercent: toWinRatePercent(summary.summary?.counts?.win_rate),
    avgPnlPerAssetUsd: summary.summary?.pnl?.avg_profit_per_trade_usd ?? null,
    avgBuyValueUsd: null,
    tokensClosed: null,
    tokensWinning: summary.summary?.counts?.total_win ?? null,
    tokensLosing: summary.summary?.counts?.total_loss ?? null,
    isArbitrage: false,
    platforms: [],
    distribution: [],
    positionsHolding: null,
    positionsSold: null,
    avgHoldTimeSecs: null,
    activity: (txs.items ?? []).map((tx) => {
      const isBuy = tx.tx_type === "buy";
      const side = isBuy ? tx.to : tx.from;
      return {
        type: isBuy ? "Buy" : ("Sell" as const),
        amountTokens: side.ui_amount,
        amountUsd: tx.volume_usd,
        priceUsd: side.price,
        mcapUsd: side.price * estimatedSupply,
        timeMs: tx.block_unix_time * 1000,
        txSignature: tx.tx_hash,
      };
    }),
    topPositions: (details.tokens ?? [])
      .filter((t) => t.address.toLowerCase() !== tokenAddress.toLowerCase())
      .sort((a, b) => (b.pnl?.realized_profit_usd ?? 0) - (a.pnl?.realized_profit_usd ?? 0))
      .slice(0, 10)
      .map((t) => {
        const avgBuyPriceUsd = t.pricing?.avg_buy_cost ?? 0;
        const avgSellPriceUsd = t.pricing?.avg_sell_cost ?? 0;
        return {
          tokenAddress: t.address,
          symbol: t.symbol,
          realizedPnlUsd: t.pnl?.realized_profit_usd ?? 0,
          roiPercent: t.pnl?.realized_profit_percent ?? 0,
          investedUsd: t.cashflow_usd?.total_invested ?? 0,
          proceedsUsd: t.cashflow_usd?.total_sold ?? 0,
          avgBuyPriceUsd,
          avgSellPriceUsd,
          // Same realized-over-deployed basis as the main table, so a wallet's
          // detail panel cannot disagree with the row that opened it.
          multipleX:
            (t.cashflow_usd?.total_invested ?? 0) > 0
              ? 1 + (t.pnl?.realized_profit_usd ?? 0) / (t.cashflow_usd?.total_invested ?? 0)
              : 0,
          tradeCount: t.counts?.total_trade ?? 0,
          holdTimeSecs: null,
          lastTradeMs: t.last_trade_unix_time ? t.last_trade_unix_time * 1000 : null,
        };
      }),
    isDemoData: false,
  };
}
