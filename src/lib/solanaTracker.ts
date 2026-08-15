// Server-only client for the Solana Tracker Data API (https://docs.solanatracker.io).
// Never import this from a "use client" component — it reads the API key from env.
import "server-only";

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

async function stFetch<T>(path: string, params?: Record<string, string | number | undefined>): Promise<T> {
  const url = new URL(path, BASE_URL);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
  }
  const res = await fetch(url, {
    headers: { "x-api-key": apiKey() },
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

export interface TokenMeta {
  address: string;
  name: string;
  symbol: string;
  imageUrl: string | null;
  priceUsd: number;
  marketCapUsd: number;
  /** Estimated circulating supply, derived from marketCapUsd / priceUsd. Used to
   * convert any historical price into an equivalent market cap for display. */
  estimatedSupply: number;
  /** Current SOL/USD price, used to convert remaining position value to SOL. */
  solPriceUsd: number;
  isToken2022: boolean;
  source: "pumpfun" | "raydium" | "other";
  market: string | null;
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

interface PriceResponse {
  price: number;
}

export async function fetchSolPriceUsd(): Promise<number> {
  const data = await stFetch<PriceResponse>("/price", { token: WSOL_ADDRESS });
  return data.price ?? 0;
}

export async function fetchTokenMeta(address: string): Promise<TokenMeta> {
  const [info, isToken2022, solPriceUsd] = await Promise.all([
    stFetch<TokenInfoResponse>(`/tokens/${address}`),
    detectTokenProgram(address),
    fetchSolPriceUsd(),
  ]);

  const primaryPool = info.pools?.slice().sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];
  const market = primaryPool?.market ?? null;
  const source: TokenMeta["source"] = market && PUMPFUN_MARKETS.has(market)
    ? "pumpfun"
    : market && RAYDIUM_MARKETS.has(market)
    ? "raydium"
    : "other";

  const priceUsd = primaryPool?.price.usd ?? 0;
  const marketCapUsd = primaryPool?.marketCap.usd ?? 0;
  // Most memecoins mint a fixed supply at launch, so current mcap/price is a
  // reliable stand-in for supply at any point in the token's history.
  const estimatedSupply = priceUsd > 0 ? marketCapUsd / priceUsd : 0;

  return {
    address,
    name: info.token.name,
    symbol: info.token.symbol,
    imageUrl: info.token.image ?? null,
    priceUsd,
    marketCapUsd,
    estimatedSupply,
    solPriceUsd,
    isToken2022,
    source,
    market,
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

export interface WalletTrader {
  rank: number;
  address: string;
  nickname: string | null;
  twitter: string | null;
  /** Identity tags from Solana Tracker, e.g. "kol", "developer", "bot", "arbitrage". */
  tags: string[];
  avgBuyPriceUsd: number;
  avgSellPriceUsd: number;
  /** Avg entry/exit expressed as market cap (price * token's estimated supply). */
  avgBuyMcapUsd: number;
  avgSellMcapUsd: number;
  buyTxns: number;
  sellTxns: number;
  boughtTokenAmount: number;
  soldTokenAmount: number;
  boughtUsd: number;
  soldUsd: number;
  realizedPnlUsd: number;
  realizedPnlPercent: number;
  avgMultipleX: number;
  /** % of purchased tokens still held (not sold). */
  remainingPercent: number;
  /** Current USD value of the remaining (unsold) position, from the API's live position data. */
  remainingValueUsd: number;
  isHolding: boolean;
  lastTradeMs: number | null;
  firstTradeMs: number | null;
  // Free bonus fields already present in the traders response (no extra credits).
  walletLifetimeRealizedPnlUsd: number | null;
  walletLifetimeTotalTrades: number | null;
  walletLifetimeTokensTraded: number | null;
}

function mapHolder(h: HolderApi, rank: number, estimatedSupply: number): WalletTrader {
  const tokensBought = h.volume.tokensBought ?? 0;
  const tokensSold = h.volume.tokensSold ?? 0;
  const buyUsd = h.volume.buyUsd ?? 0;
  const sellUsd = h.volume.sellUsd ?? 0;
  const avgBuyPriceUsd = tokensBought > 0 ? buyUsd / tokensBought : 0;
  const avgSellPriceUsd = tokensSold > 0 ? sellUsd / tokensSold : 0;
  const remainingPercent = tokensBought > 0 ? Math.max(0, ((tokensBought - tokensSold) / tokensBought) * 100) : 0;

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
    boughtUsd: buyUsd,
    soldUsd: sellUsd,
    realizedPnlUsd: h.pnl?.token?.realized ?? 0,
    realizedPnlPercent: h.roi ?? 0,
    avgMultipleX: avgBuyPriceUsd > 0 ? avgSellPriceUsd / avgBuyPriceUsd : 0,
    remainingPercent,
    remainingValueUsd: h.current?.value ?? 0,
    isHolding: (h.current?.balance ?? 0) > 0,
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
    const remaining = limit - traders.length;
    const page = await stFetch<TokenTradersResponse>(`/v2/pnl/tokens/${address}/traders`, {
      sort: "realized",
      direction: "desc",
      limit: Math.min(PAGE_SIZE, remaining),
      cursor,
    });

    page.traders.forEach((h) => traders.push(mapHolder(h, traders.length + 1, estimatedSupply)));

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

export interface WalletDetail {
  address: string;
  twitter: string | null;
  tags: string[];
  totalValueUsd: number;
  solBalance: number;
  walletRealizedPnlUsd: number;
  walletUnrealizedPnlUsd: number;
  winRatePercent: number | null;
  avgPnlPerAssetUsd: number | null;
  avgBuyValueUsd: number | null;
  tokensClosed: number;
  tokensWinning: number;
  tokensLosing: number;
  isArbitrage: boolean;
  platforms: string[];
  distribution: Array<{ label: string; count: number }>;
  positionsHolding: number;
  positionsSold: number;
  avgHoldTimeSecs: number;
  activity: Array<{
    type: "Buy" | "Sell";
    amountTokens: number;
    amountUsd: number;
    priceUsd: number;
    mcapUsd: number;
    timeMs: number;
    txSignature: string;
  }>;
}

export async function fetchWalletDetail(
  tokenAddress: string,
  walletAddress: string,
  estimatedSupply: number
): Promise<WalletDetail> {
  const [basic, summary, trades] = await Promise.all([
    stFetch<WalletBasicResponse>(`/wallet/${walletAddress}/basic`),
    stFetch<WalletSummaryResponse>(`/v2/pnl/wallets/${walletAddress}`),
    stFetch<TokenTradesResponse>(`/trades/${tokenAddress}/by-wallet/${walletAddress}`, {
      sortDirection: "DESC",
    }),
  ]);

  return {
    address: walletAddress,
    twitter: summary.identity?.twitter ?? null,
    tags: summary.identity?.tags ?? [],
    totalValueUsd: basic.total ?? 0,
    solBalance: basic.totalSol ?? 0,
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
  };
}

export function isSolanaTrackerConfigured(): boolean {
  return Boolean(process.env.SOLANA_TRACKER_API_KEY);
}
