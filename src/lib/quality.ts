// The bar a wallet-token result must clear to count as a *win* and to be worth
// spending a paid enrichment call on.
//
// It is deliberately NOT a write gate. It used to be one, and the cost was that
// `wallet_tokens` contained only trades that made 2x AND $1k: a wallet appearing
// five times had five wins and an unknown number of losses, so win rate was
// uncomputable and every wallet in the database looked like a genius. Every
// trader row from a scan is now stored, carrying the verdict as a column.
//
// Where it still gates: enrichment API calls (Solana Tracker credits, Birdeye
// CUs) and win badges. Those cost real money or make a claim about a wallet.
// Storage is ~100 bytes a row and was never the constraint.
//
// scripts/enrich-wallets.mjs duplicates these values; it cannot import from
// src/lib (the `server-only` boundary), so change both together.

export const MIN_WALLET_MULTIPLE_X = 2;
export const MIN_WALLET_PNL_USD = 1000;

/**
 * Smallest cost basis a multiple may be divided by. Tokens that arrive by
 * airdrop or transfer are never recorded as buys, so the tracked basis can be a
 * few dollars of dust against a five-figure profit — which yields a real PNL but
 * a meaningless 1423x. Below this, report the PNL and omit the multiple.
 */
export const MIN_COST_BASIS_USD = 100;

/**
 * Above this, a multiple is an artifact rather than a trade. Live example: a
 * wallet with ONE $39.46 buy and 225 sells of 15.95M tokens reports 587x — the
 * $23,152 profit is real, but the tokens it sold mostly arrived by transfer, so
 * there is no basis to measure a return against.
 */
export const MAX_PLAUSIBLE_MULTIPLE_X = 500;

/**
 * Denominator for a realized return: the cost of the tokens actually sold.
 *
 * Falls back to total buy volume when that basis is dust, which understates the
 * multiple rather than inflating it — a wallet with $126K profit against $89 of
 * tracked basis is an untracked-transfer artifact, not a 1423x trader.
 */
export function realizedBasisUsd(soldCostBasisUsd: number, boughtUsd: number): number {
  if (soldCostBasisUsd >= MIN_COST_BASIS_USD) return soldCostBasisUsd;
  return Math.max(soldCostBasisUsd, boughtUsd);
}

/**
 * The multiple to display, or null when the basis is too small to divide by.
 * The PNL stays visible either way — an absent ratio is honest, a 587x is not.
 */
export function displayMultiple(pnlUsd: number, basisUsd: number): number | null {
  if (!Number.isFinite(pnlUsd) || !Number.isFinite(basisUsd) || basisUsd <= 0) return null;
  const x = 1 + pnlUsd / basisUsd;
  return x > MAX_PLAUSIBLE_MULTIPLE_X ? null : x;
}

/** True when a result counts as a win — worth a badge, and worth enriching. */
export function meetsQualityBar(multipleX: number | null, pnlUsd: number | null): boolean {
  return qualityVerdict(multipleX, pnlUsd).qualified;
}

/**
 * Why a row failed the bar. A boolean would be enough to compute a win rate, but
 * "didn't make $1k" and "has no measurable multiple because the tokens arrived
 * by transfer" are completely different claims about a wallet, and the figures
 * they were derived from get overwritten by the next rescan.
 */
export type DisqualifiedReason =
  | "below_multiple"
  | "below_pnl"
  | "below_both"
  | "no_multiple"
  | "not_finite";

export interface QualityVerdict {
  qualified: boolean;
  /** Null exactly when `qualified`. */
  reason: DisqualifiedReason | null;
}

/** The bar, plus which test a failing row failed. */
export function qualityVerdict(
  multipleX: number | null,
  pnlUsd: number | null
): QualityVerdict {
  // A null multiple is not a loss: the PNL can be large and real while the cost
  // basis is dust from an untracked transfer. It is recorded as its own reason
  // so those rows can be classified later rather than counted as losses.
  if (multipleX === null || pnlUsd === null) return { qualified: false, reason: "no_multiple" };
  if (!Number.isFinite(multipleX) || !Number.isFinite(pnlUsd)) {
    return { qualified: false, reason: "not_finite" };
  }

  const belowMultiple = multipleX < MIN_WALLET_MULTIPLE_X;
  const belowPnl = pnlUsd < MIN_WALLET_PNL_USD;
  if (belowMultiple && belowPnl) return { qualified: false, reason: "below_both" };
  if (belowMultiple) return { qualified: false, reason: "below_multiple" };
  if (belowPnl) return { qualified: false, reason: "below_pnl" };
  return { qualified: true, reason: null };
}

/**
 * Both upstreams report CUMULATIVE trade volume per wallet, not a net position.
 * For a wallet that round-trips the same tokens thousands of times, every figure
 * derived from those volumes — avg entry, avg exit, bag size, transferred-out
 * share, multiple — describes the bot's churn, not a trade anyone can copy.
 *
 * Live example (BSC 老吴, 0x8b7a…7777, a 7-day-old token): the top three rows by
 * realized PNL were wallets with 6,900+ trades each that had "bought" 98.8%,
 * 83.3% and 76.0% of the entire circulating supply. Their top-40 buy volumes
 * summed to 3.67x total supply. Rendered as positions they read
 * "$699.1K -> $1.57M entry/exit, sold 4.2% of bag, 96% moved out". GMGN excludes
 * all three from its top 100 for the same token; these two tests reproduce that
 * decision exactly while keeping every wallet GMGN does rank.
 *
 * Deliberately NOT keyed off upstream bot tags: Birdeye labels wallets with 2
 * buys and 9 sells "arbitrage-bot", and one of those is GMGN's #6 trader.
 */
export const MAX_PLAUSIBLE_TOKEN_TRADES = 1000;
export const MAX_PLAUSIBLE_SUPPLY_SHARE = 0.5;

export function isVolumeArtifact(
  tokenTrades: number,
  boughtTokenAmount: number,
  estimatedSupply: number
): boolean {
  if (tokenTrades > MAX_PLAUSIBLE_TOKEN_TRADES) return true;
  if (estimatedSupply <= 0) return false;
  return boughtTokenAmount / estimatedSupply > MAX_PLAUSIBLE_SUPPLY_SHARE;
}
