// Server-only client for the Solana Tracker Data API (https://docs.solanatracker.io).
// Never import this from a "use client" component — it reads the API key from env.
import "server-only";
import type { TokenMeta, WalletDetail, WalletTrader } from "./types";
import { displayMultiple, isVolumeArtifact, realizedBasisUsd } from "./quality";

const BASE_URL = "https://data.solanatracker.io";
const RPC_URL = "https://api.mainnet-beta.solana.com";
const TOKEN_2022_PROGRAM_ID = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

export class SolanaTrackerError extends Error {
  constructor(message: string, public status?: number) {
    super(message);
  }
}

function apiKey(): string {
  const key = process.env.SOLANA_TRACKER_API_KEY;
  if (!key) {
    throw new SolanaTrackerError("SOLANA_TRACKER_API_KEY is not configured.");
  }
  return key;
}

async function stFetch<T>(
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
  const res = await fetch(url, {
    method: jsonBody ? "POST" : "GET",
    headers: {
      "x-api-key": apiKey(),
      ...(jsonBody ? { "Content-Type": "application/json" } : {}),
    },
    body: jsonBody ? JSON.stringify(jsonBody) : undefined,
    // Trader/PNL data changes fast; avoid stale cached responses.
    cache: "no-store",
  });
  if (!res.ok) {
    let message = `Solana Tracker request failed (${res.status})`;
    try {
      const body = await res.json();
      if (body?.error) message = body.error;
    } catch {
      // ignore parse failure, use default message
    }
    throw new SolanaTrackerError(message, res.status);
  }
  return res.json() as Promise<T>;
}

// --- Token metadata ---

interface TokenInfoResponse {
  token: { name: string; symbol: string; mint: string; decimals: number; image?: string };
  pools: Array<{
    market: string;
    liquidity: { usd: number };
    price: { usd: number };
    marketCap: { usd: number };
  }>;
}

const PUMPFUN_MARKETS = new Set(["pumpfun", "pumpfun-amm"]);
const RAYDIUM_MARKETS = new Set(["raydium", "raydium-clmm", "raydium-cpmm", "raydium-launchpad"]);

async function detectTokenProgram(mint: string): Promise<boolean> {
  try {
    const res = await fetch(RPC_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "getAccountInfo",
        params: [mint, { encoding: "jsonParsed" }],
      }),
      cache: "no-store",
    });
    const data = await res.json();
    return data?.result?.value?.owner === TOKEN_2022_PROGRAM_ID;
  } catch {
    // If the RPC call fails we simply can't confirm Token-2022; default to false.
    return false;
  }
}

const WSOL_ADDRESS = "So11111111111111111111111111111111111111112";

/**
 * Ground-truth supply straight from the chain. Reverse-engineering supply as
 * marketCap/price from a pool was fragile: some tokens carry long-abandoned
 * pools with near-zero liquidity that still report a price (e.g. one Pnut
 * pool with $0.88 of liquidity priced the token 32x above every real pool),
 * and if a bad scan ever let one through, every wallet recorded in that scan
 * inherited a poisoned mcap. A single on-chain read can't be fooled that way.
 */
export async function fetchTokenSupply(mint: string): Promise<number> {
  try {
    const res = await fetch(RPC_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "getTokenSupply",
        params: [mint],
      }),
      cache: "no-store",
    });
    const data = await res.json();
    return data?.result?.value?.uiAmount ?? 0;
  } catch {
    return 0;
  }
}

interface PriceResponse {
  price: number;
}

export async function fetchSolPriceUsd(): Promise<number> {
  const data = await stFetch<PriceResponse>("/price", { token: WSOL_ADDRESS });
  return data.price ?? 0;
}

export async function fetchTokenMeta(address: string): Promise<TokenMeta> {
  const [info, isToken2022, solPriceUsd, chainSupply] = await Promise.all([
    stFetch<TokenInfoResponse>(`/tokens/${address}`),
    detectTokenProgram(address),
    fetchSolPriceUsd(),
    fetchTokenSupply(address),
  ]);

  // Liquidity under this floor is thin enough that a single trade can move its
  // reported price by orders of magnitude, so those pools are excluded before
  // picking the "primary" one purely by liquidity. Falls back to the raw list
  // if every pool is this thin (e.g. a token with no real pools yet).
  const MIN_POOL_LIQUIDITY_USD = 1000;
  const liquidPools = info.pools?.filter((p) => (p.liquidity?.usd ?? 0) >= MIN_POOL_LIQUIDITY_USD);
  const candidates = liquidPools && liquidPools.length > 0 ? liquidPools : info.pools;
  const primaryPool = candidates?.slice().sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];
  const market = primaryPool?.market ?? null;
  const source: TokenMeta["source"] = market && PUMPFUN_MARKETS.has(market)
    ? "pumpfun"
    : market && RAYDIUM_MARKETS.has(market)
    ? "raydium"
    : "other";

  const priceUsd = primaryPool?.price.usd ?? 0;
  // Supply comes from the chain, not from marketCap/price division — see
  // fetchTokenSupply. marketCapUsd is then derived from it so every mcap
  // figure in the app (this token's, and every wallet's avg buy/sell mcap)
  // shares the same single source of truth instead of trusting a pool's own
  // (sometimes wrong) marketCap figure.
  const estimatedSupply = chainSupply > 0 ? chainSupply : priceUsd > 0 ? (primaryPool?.marketCap.usd ?? 0) / priceUsd : 0;
  const marketCapUsd = priceUsd * estimatedSupply;

  return {
    chain: "solana",
    address,
    name: info.token.name,
    symbol: info.token.symbol,
    imageUrl: info.token.image ?? null,
    priceUsd,
    marketCapUsd,
    estimatedSupply,
    nativePriceUsd: solPriceUsd,
    isToken2022,
    source,
    market,
    rankingWindow: "all_time",
  };
}

// --- Top traders ---

interface HolderApi {
  wallet: string;
  identity?: {
    name?: string | null;
    twitter?: string | null;
    type?: string | null;
    tags?: string[];
    platforms?: string[];
  };
  roi: number | null;
  invested: number | null;
  proceeds: number | null;
  volume: { tokensBought: number | null; tokensSold: number | null; buyUsd: number | null; sellUsd: number | null };
  counts: { buys: number; sells: number; total: number };
  current: { balance: number | null; value: number | null };
  timing: { firstTrade: number | null; lastTrade: number | null };
  pnl: {
    token: { realized: number; unrealized: number; total: number };
    wallet?: {
      realized: number;
      unrealized: number;
      total: number;
      invested: number;
      proceeds: number;
      totalTrades: number;
      tokensTraded: number;
    };
  };
}

interface TokenTradersResponse {
  meta: { symbol: string; name: string; image?: string; price: number; marketCap: number };
  traders: HolderApi[];
  pagination: { hasMore: boolean; nextCursor?: string; count: number; total: number };
}

function mapHolder(h: HolderApi, rank: number, estimatedSupply: number): WalletTrader {
  const tokensBought = h.volume.tokensBought ?? 0;
  const tokensSold = h.volume.tokensSold ?? 0;
  const buyUsd = h.volume.buyUsd ?? 0;
  const sellUsd = h.volume.sellUsd ?? 0;
  const avgBuyPriceUsd = tokensBought > 0 ? buyUsd / tokensBought : 0;
  const avgSellPriceUsd = tokensSold > 0 ? sellUsd / tokensSold : 0;

  // Measure the leftover against the live balance, not bought-minus-sold: tokens
  // arrive by transfer and airdrop too, so on 21 of Pnut's top 100 wallets sold
  // exceeds bought and the subtraction invents a position that is already closed.
  // A null balance means upstream didn't report one — kept as unknown, since a 0
  // here would claim the wallet fully exited.
  const balance = h.current?.balance ?? null;
  const remainingPercent =
    balance === null ? null : tokensBought > 0 ? Math.min(100, (balance / tokensBought) * 100) : 0;

  // Avg entry/exit are lifetime volume-weighted averages across every fill, so their
  // ratio describes price movement, NOT what the wallet actually made: a trader who
  // buys 100 and only sells 75 has cost in `buyUsd` that was never realized. Upstream
  // `realized` matches sold lots to their own basis, so anchor both the % and the
  // multiple to it instead. `h.roi` is unusable directly -- it leaks unrealized losses
  // into the sign (wallet 4HwUKe reports roi -12.7 alongside realized +$3.16M).
  const realizedPnlUsd = h.pnl?.token?.realized ?? 0;
  // ...and the denominator has to match: only the sold lots' own cost basis, or a
  // wallet that offloaded 4% of its bag at 2.4x reports 1.06x.
  const soldCostBasisUsd = Math.min(tokensSold, tokensBought) * avgBuyPriceUsd;
  const realizedBasis = realizedBasisUsd(soldCostBasisUsd, buyUsd);
  const multiple = displayMultiple(realizedPnlUsd, realizedBasis);
  const realizedPnlPercent = multiple === null ? 0 : (multiple - 1) * 100;

  return {
    rank,
    address: h.wallet,
    nickname: h.identity?.name ?? null,
    twitter: h.identity?.twitter ?? null,
    tags: h.identity?.tags ?? [],
    avgBuyPriceUsd,
    avgSellPriceUsd,
    avgBuyMcapUsd: avgBuyPriceUsd * estimatedSupply,
    avgSellMcapUsd: avgSellPriceUsd * estimatedSupply,
    buyTxns: h.counts?.buys ?? 0,
    sellTxns: h.counts?.sells ?? 0,
    boughtTokenAmount: tokensBought,
    soldTokenAmount: tokensSold,
    transferredOutPercent:
      balance === null || tokensBought <= 0
        ? null
        : Math.min(100, Math.max(0, ((tokensBought - tokensSold - balance) / tokensBought) * 100)),
    boughtUsd: buyUsd,
    soldUsd: sellUsd,
    soldCostBasisUsd,
    realizedPnlUsd,
    realizedPnlPercent,
    avgMultipleX: multiple,
    remainingPercent,
    remainingValueUsd: balance === null ? null : h.current?.value ?? 0,
    isHolding: balance === null ? null : balance > 0,
    unrealizedPnlUsd: h.pnl?.token?.unrealized ?? null,
    lastTradeMs: h.timing?.lastTrade ?? null,
    firstTradeMs: h.timing?.firstTrade ?? null,
    walletLifetimeRealizedPnlUsd: h.pnl?.wallet?.realized ?? null,
    walletLifetimeTotalTrades: h.pnl?.wallet?.totalTrades ?? null,
    walletLifetimeTokensTraded: h.pnl?.wallet?.tokensTraded ?? null,
  };
}

export async function fetchTopTraders(address: string, limit: number, estimatedSupply: number): Promise<WalletTrader[]> {
  const traders: WalletTrader[] = [];
  let cursor: string | undefined;
  const PAGE_SIZE = 200;

  while (traders.length < limit) {
    // A full page every time, not `limit - traders.length`: dropping artifacts
    // would otherwise leave the result short of what the buyer paid for.
    const page = await stFetch<TokenTradersResponse>(`/v2/pnl/tokens/${address}/traders`, {
      sort: "realized",
      direction: "desc",
      limit: PAGE_SIZE,
      cursor,
    });

    for (const h of page.traders) {
      // Churn bots are excluded before mapping — see isVolumeArtifact.
      if (isVolumeArtifact(h.counts?.total ?? 0, h.volume.tokensBought ?? 0, estimatedSupply)) {
        continue;
      }
      if (traders.length >= limit) break;
      traders.push(mapHolder(h, traders.length + 1, estimatedSupply));
    }

    if (!page.pagination.hasMore || !page.pagination.nextCursor) break;
    cursor = page.pagination.nextCursor;
  }

  return traders;
}

// --- Wallet detail (on-demand, single wallet) ---

interface WalletBasicResponse {
  total: number;
  totalSol: number;
}

interface WalletSummaryResponse {
  identity?: { name?: string | null; twitter?: string | null; type?: string | null; tags?: string[] };
  summary: {
    pnl: { realized: number; unrealized: number; total: number };
    timing: { firstTrade: number; lastTrade: number; avgHoldTimeSecs: number };
  };
  analysis: {
    winRate: number | null;
    avgPnlPerAsset: number | null;
    avgBuyValue: number | null;
    tokens: { closed: number; winning: number; losing: number };
    distribution: Array<{ range: string; count: number; rate: number | null }>;
  };
  stats: { total: number; holding: number; sold: number; profitable: number; losing: number };
  tags?: { isArbitrage: boolean; platforms: string[] };
}

interface TokenTradeApi {
  tx: string;
  amount: number;
  priceUsd: number;
  volume: number;
  type: "buy" | "sell";
  time: number;
}

interface TokenTradesResponse {
  trades: TokenTradeApi[];
}

interface WalletPositionApi {
  token: string;
  pnl: { realized: number };
  invested: number | null;
  proceeds: number | null;
  roi: number | null;
  volume: { tokensBought: number | null; tokensSold: number | null; buyUsd: number | null; sellUsd: number | null };
  counts: { total: number };
  timing: { holdTimeSecs: number | null; lastTrade: number | null };
  meta?: { symbol?: string | null };
}

interface WalletPositionsResponse {
  positions: WalletPositionApi[];
}

export async function fetchWalletDetail(
  tokenAddress: string,
  walletAddress: string,
  estimatedSupply: number
): Promise<WalletDetail> {
  const [basic, summary, trades, positions] = await Promise.all([
    stFetch<WalletBasicResponse>(`/wallet/${walletAddress}/basic`),
    stFetch<WalletSummaryResponse>(`/v2/pnl/wallets/${walletAddress}`),
    stFetch<TokenTradesResponse>(`/trades/${tokenAddress}/by-wallet/${walletAddress}`, {
      sortDirection: "DESC",
    }),
    stFetch<WalletPositionsResponse>(`/v2/pnl/wallets/${walletAddress}/positions`, {
      sort: "pnl",
      direction: "desc",
      limit: 10,
    }).catch(() => ({ positions: [] })),
  ]);

  return {
    address: walletAddress,
    twitter: summary.identity?.twitter ?? null,
    tags: summary.identity?.tags ?? [],
    totalValueUsd: basic.total ?? 0,
    nativeBalance: basic.totalSol ?? 0,
    walletRealizedPnlUsd: summary.summary?.pnl?.realized ?? 0,
    walletUnrealizedPnlUsd: summary.summary?.pnl?.unrealized ?? 0,
    winRatePercent: summary.analysis?.winRate ?? null,
    avgPnlPerAssetUsd: summary.analysis?.avgPnlPerAsset ?? null,
    avgBuyValueUsd: summary.analysis?.avgBuyValue ?? null,
    tokensClosed: summary.analysis?.tokens?.closed ?? 0,
    tokensWinning: summary.analysis?.tokens?.winning ?? 0,
    tokensLosing: summary.analysis?.tokens?.losing ?? 0,
    isArbitrage: summary.tags?.isArbitrage ?? false,
    platforms: summary.tags?.platforms ?? [],
    distribution: (summary.analysis?.distribution ?? []).map((d) => ({ label: d.range, count: d.count })),
    positionsHolding: summary.stats?.holding ?? 0,
    positionsSold: summary.stats?.sold ?? 0,
    avgHoldTimeSecs: summary.summary?.timing?.avgHoldTimeSecs ?? 0,
    activity: (trades.trades ?? []).map((t) => ({
      type: t.type === "buy" ? "Buy" : "Sell",
      amountTokens: t.amount,
      amountUsd: t.volume,
      priceUsd: t.priceUsd,
      mcapUsd: t.priceUsd * estimatedSupply,
      timeMs: t.time,
      txSignature: t.tx,
    })),
    topPositions: (positions.positions ?? [])
      .filter((p) => p.token !== tokenAddress)
      .map((p) => {
        const tokensBought = p.volume?.tokensBought ?? 0;
        const tokensSold = p.volume?.tokensSold ?? 0;
        const avgBuyPriceUsd = tokensBought > 0 ? (p.volume?.buyUsd ?? 0) / tokensBought : 0;
        const avgSellPriceUsd = tokensSold > 0 ? (p.volume?.sellUsd ?? 0) / tokensSold : 0;
        const invested = p.invested ?? 0;
        const realized = p.pnl?.realized ?? 0;
        return {
          tokenAddress: p.token,
          symbol: p.meta?.symbol ?? p.token.slice(0, 4),
          realizedPnlUsd: realized,
          // Derived from the same basis as multipleX rather than p.roi, which
          // leaks unrealized losses into the sign and would let this row read
          // "12.4x" and "-12.7%" at the same time.
          roiPercent: invested > 0 ? (realized / invested) * 100 : 0,
          investedUsd: invested,
          proceedsUsd: p.proceeds ?? 0,
          avgBuyPriceUsd,
          avgSellPriceUsd,
          // Same realized-over-deployed basis as the main table, so a wallet's
          // detail panel cannot disagree with the row that opened it.
          multipleX: invested > 0 ? 1 + realized / invested : 0,
          tradeCount: p.counts?.total ?? 0,
          holdTimeSecs: p.timing?.holdTimeSecs ?? null,
          lastTradeMs: p.timing?.lastTrade ?? null,
        };
      }),
    isDemoData: false,
  };
}

export function isSolanaTrackerConfigured(): boolean {
  return Boolean(process.env.SOLANA_TRACKER_API_KEY);
}

interface BatchWalletsResponse {
  wallets: Array<{
    wallet: string;
    summary?: {
      pnl?: { realized?: number };
      counts?: { trades?: number; tokensTraded?: number };
      winRate?: number | null;
    };
    analysis?: { winRate?: number | null };
  }>;
}

/**
 * Lifetime PNL for many wallets, 100 per request — cheap enough to enrich every
 * scanned wallet. Used to detect survivorship bias (big win on one token but
 * negative lifetime PNL = lucky, not alpha).
 */
export async function fetchWalletLifetimeBatch(
  addresses: string[]
): Promise<Array<{ address: string; pnlUsd: number | null; winRate: number | null; trades: number | null; tokensTraded: number | null }>> {
  const BATCH_SIZE = 100;
  const out: Array<{ address: string; pnlUsd: number | null; winRate: number | null; trades: number | null; tokensTraded: number | null }> = [];

  for (let i = 0; i < addresses.length; i += BATCH_SIZE) {
    const chunk = addresses.slice(i, i + BATCH_SIZE);
    try {
      const res = await stFetch<BatchWalletsResponse>("/v2/pnl/wallets/batch", undefined, {
        wallets: chunk,
      });
      for (const w of res.wallets ?? []) {
        out.push({
          address: w.wallet,
          pnlUsd: w.summary?.pnl?.realized ?? null,
          winRate: w.analysis?.winRate ?? w.summary?.winRate ?? null,
          trades: w.summary?.counts?.trades ?? null,
          tokensTraded: w.summary?.counts?.tokensTraded ?? null,
        });
      }
    } catch {
      // Enrichment is best-effort; a failure must not break the scan.
    }
  }
  return out;
}
