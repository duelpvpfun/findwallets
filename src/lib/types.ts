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
  /**
   * Share of the bag that left the wallet without being sold (0-100), or null
   * when the live balance is unknown. Without this, a wallet that bought 974M
   * tokens, sold 41M and moved the rest out reads as a catastrophic loss:
   * "Bought $666K -> Sold $65K" describes two different quantities of tokens.
   */
  transferredOutPercent: number | null;
  boughtUsd: number;
  soldUsd: number;
  /** Cost basis of only the tokens actually sold. The denominator for realized
   * returns: dividing by `boughtUsd` would charge a round trip for tokens the
   * wallet still holds or transferred away, turning a 2.4x into 1.06x. */
  soldCostBasisUsd: number;
  realizedPnlUsd: number;
  realizedPnlPercent: number;
  /**
   * Null when the cost basis is too small to divide by — a wallet whose tokens
   * mostly arrived by transfer has a real PNL but no measurable return. The PNL
   * is still shown; the ratio is withheld rather than reported as 587x.
   */
  avgMultipleX: number | null;
  // Not available on non-Solana chains (no live position-balance data there).
  remainingPercent: number | null;
  remainingValueUsd: number | null;
  isHolding: boolean | null;
  /** Paper gain on the unsold position. Realized PNL alone understates a wallet
   * that is still holding, so totals should read both. */
  unrealizedPnlUsd: number | null;
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

/** A wallet's previously recorded wins on other tokens, from the local database. */
export interface WalletHistory {
  priorTokenCount: number;
  lifetimePnlUsd: number | null;
  isBot: boolean;
  wins: Array<{ symbol: string; realizedPnlUsd: number; multipleX: number | null }>;
  /** Pre-rendered `[27X] $42.1K $WIF` wins on tokens nobody scanned here. */
  winBadges: string[];
}

/** The full payload of a completed scan. */
export interface ScanResult {
  token: TokenMeta;
  traders: WalletTrader[];
  histories?: Record<string, WalletHistory>;
  isDemoData: boolean;
  note?: string;
  /** The time budget ran out before the paid tier could be filled. */
  partial?: boolean;
  deliveredCount?: number;
  requestedCount?: number;
  scanSession?: string;
  /**
   * Which purchase actually paid for this scan.
   *
   * The client must not assume its localStorage claim token was the one spent:
   * a signed-in buyer's account balance is tried first, and clearing the browser
   * copy on that assumption would throw away an unspent purchase.
   */
  creditSource?: "account" | "claim_token";
  /** Set when this payload came back out of storage rather than from a scan. */
  fromStoredResult?: boolean;
  /** ISO date a stored result is purged on. Only present on a re-download. */
  expiresAt?: string;
}

/** NDJSON lines emitted by `/api/top-traders?stream=1`, one per line. */
export type ScanEvent =
  | { type: "token"; token: TokenMeta }
  | { type: "progress"; found: number; requested: number }
  | { type: "result"; result: ScanResult }
  | { type: "error"; error: string };

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

/** A wallet's historical performance on one other token, for judging consistency. */
export interface WalletTokenPosition {
  tokenAddress: string;
  symbol: string;
  realizedPnlUsd: number;
  roiPercent: number;
  investedUsd: number;
  proceedsUsd: number;
  avgBuyPriceUsd: number;
  avgSellPriceUsd: number;
  multipleX: number;
  tradeCount: number;
  holdTimeSecs: number | null;
  lastTradeMs: number | null;
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
  /** This wallet's best other trades, to gauge whether it's consistently profitable. */
  topPositions: WalletTokenPosition[];
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
