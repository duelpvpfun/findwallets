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
  remainingPercent: number;
  remainingValueUsd: number;
  isHolding: boolean;
  lastTradeMs: number | null;
  firstTradeMs: number | null;
  walletLifetimeRealizedPnlUsd: number | null;
  walletLifetimeTotalTrades: number | null;
  walletLifetimeTokensTraded: number | null;
}

export interface TokenMeta {
  address: string;
  name: string;
  symbol: string;
  imageUrl: string | null;
  priceUsd: number;
  marketCapUsd: number;
  estimatedSupply: number;
  solPriceUsd: number;
  isToken2022: boolean;
  source: "pumpfun" | "raydium" | "other";
  market: string | null;
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
  distribution: WalletDistributionBucket[];
  positionsHolding: number;
  positionsSold: number;
  avgHoldTimeSecs: number;
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
