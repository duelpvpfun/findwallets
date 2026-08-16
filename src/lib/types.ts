export type Chain = "solana" | "bsc" | "base";

export interface WalletTrader {
  rank: number;
  address: string;
  nickname: string | null;
  twitter: string | null;
  tags: string[];
  avgBuyPriceUsd: number;
  avgSellPriceUsd: number;
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
  // Not available on non-Solana chains (no live position-balance data there).
  remainingPercent: number | null;
  remainingValueUsd: number | null;
  isHolding: boolean | null;
  lastTradeMs: number | null;
  firstTradeMs: number | null;
  walletLifetimeRealizedPnlUsd: number | null;
  walletLifetimeTotalTrades: number | null;
  walletLifetimeTokensTraded: number | null;
}

export interface TokenMeta {
  chain: Chain;
  address: string;
  name: string;
  symbol: string;
  imageUrl: string | null;
  priceUsd: number;
  marketCapUsd: number;
  estimatedSupply: number;
  /** USD price of the chain's native coin (SOL/BNB/ETH), for "remaining position in native units". */
  nativePriceUsd: number;
  isToken2022: boolean;
  source: "pumpfun" | "raydium" | "other";
  market: string | null;
  /** Ranking window actually used, e.g. "all_time" (Solana) or "90d" (BSC/Base max lookback). */
  rankingWindow: string;
}

export interface TopTradersResponse {
  token: TokenMeta;
  traders: WalletTrader[];
  isDemoData: boolean;
}

export interface WalletDistributionBucket {
  label: string;
  count: number;
}

export interface WalletActivityRow {
  type: "Buy" | "Sell";
  amountTokens: number;
  amountUsd: number;
  priceUsd: number;
  mcapUsd: number;
  timeMs: number;
  txSignature: string;
}

export interface WalletDetail {
  address: string;
  twitter: string | null;
  tags: string[];
  // Wallet balance/portfolio data only exists for Solana (Birdeye has no
  // equivalent wallet-portfolio endpoint for BSC/Base at this time).
  totalValueUsd: number | null;
  nativeBalance: number | null;
  walletRealizedPnlUsd: number;
  walletUnrealizedPnlUsd: number;
  winRatePercent: number | null;
  avgPnlPerAssetUsd: number | null;
  avgBuyValueUsd: number | null;
  tokensClosed: number | null;
  tokensWinning: number | null;
  tokensLosing: number | null;
  isArbitrage: boolean;
  platforms: string[];
  distribution: WalletDistributionBucket[];
  positionsHolding: number | null;
  positionsSold: number | null;
  avgHoldTimeSecs: number | null;
  activity: WalletActivityRow[];
  isDemoData: boolean;
}

export type ExportGroup = {
  trackedWalletAddress: string;
  name: string;
  emoji: string;
  alertsOnToast: boolean;
  alertsOnBubble: boolean;
  alertsOnFeed: boolean;
  groups: string[];
  sound: string;
};
