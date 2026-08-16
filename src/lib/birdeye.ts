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
  params?: Record<string, string | number | undefined>
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
      headers: { "X-API-KEY": apiKey(), "x-chain": chain },
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
  const estimatedSupply = market.circulating_supply ?? market.total_supply ?? 0;

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

function mapTopTrader(item: TopTraderItem, rank: number, estimatedSupply: number): WalletTrader {
  const avgBuyPriceUsd = item.volumeBuy > 0 ? item.volumeBuyUSD / item.volumeBuy : 0;
  const avgSellPriceUsd = item.volumeSell > 0 ? item.volumeSellUSD / item.volumeSell : 0;
  const boughtUsd = item.volumeBuyUSD;
  const soldUsd = item.volumeSellUSD;
  const costBasisOfSold = item.volumeSell * avgBuyPriceUsd;
  const realizedPnlPercent = costBasisOfSold > 0 ? (item.realizedPnl / costBasisOfSold) * 100 : 0;

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
    boughtUsd,
    soldUsd,
    realizedPnlUsd: item.realizedPnl,
    realizedPnlPercent,
    avgMultipleX: avgBuyPriceUsd > 0 ? avgSellPriceUsd / avgBuyPriceUsd : 0,
    // Not available from this endpoint on non-Solana chains (no live position data).
    remainingPercent: null,
    remainingValueUsd: null,
    isHolding: null,
    lastTradeMs: null,
    firstTradeMs: null,
    walletLifetimeRealizedPnlUsd: null,
    walletLifetimeTotalTrades: null,
    walletLifetimeTokensTraded: null,
  };
}

const PAGE_SIZE = 10; // Hard API limit, confirmed live — see module doc comment.
const MAX_CONCURRENT_PAGES = 10; // Pacing is enforced by acquireRateLimitSlot().

export async function fetchEvmTopTraders(
  chain: EvmChain,
  address: string,
  limit: number,
  estimatedSupply: number,
  timeFrame: string = "90d"
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
    for (const page of pages) {
      if (!page.items || page.items.length === 0) {
        return traders.map((t, i) => ({ ...t, rank: i + 1 }));
      }
      page.items.forEach((item) => traders.push(mapTopTrader(item, traders.length + 1, estimatedSupply)));
    }
  }

  return traders.slice(0, limit).map((t, i) => ({ ...t, rank: i + 1 }));
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

export async function fetchEvmWalletDetail(
  chain: EvmChain,
  tokenAddress: string,
  walletAddress: string,
  estimatedSupply: number
): Promise<WalletDetail> {
  const [summary, txs] = await Promise.all([
    beFetch<WalletPnlSummaryResponse>(chain, "/wallet/v2/pnl/summary", { wallet: walletAddress }),
    beFetch<TokenTxsResponse>(chain, "/defi/v3/token/txs", {
      address: tokenAddress,
      owner: walletAddress,
      sort_by: "block_unix_time",
      sort_type: "desc",
      limit: 20,
    }),
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
    winRatePercent: summary.summary?.counts?.win_rate ?? null,
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
    isDemoData: false,
  };
}
