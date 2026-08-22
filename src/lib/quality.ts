// The bar a wallet-token result must clear to earn a row or a tag anywhere in
// the database. Enforced on every write path — the scan route, the persistence
// layer, and the GMGN enrichment worker — so nothing below it can reach the
// table by a route we forgot about.
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
 * Above this, a multiple needs corroborating before it is believed. Live
 * example: a wallet with ONE $39.46 buy and 225 sells of 15.95M tokens reports
 * 587x — the $23,152 profit is real, but the tokens it sold mostly arrived by
 * transfer, so there is no basis to measure a return against.
 */
export const MAX_PLAUSIBLE_MULTIPLE_X = 500;

/**
 * How far the price-implied multiple may sit from the basis-implied one before a
 * big multiple is treated as an artifact.
 *
 * A flat cap suppressed real trades. A wallet that turned $299 into $204K on
 * TENDIES read `n/a` at 683x while the entry and exit market caps on the same
 * row said $34.8K → $23.75M, which is 682x — the row was calling its own
 * numbers implausible. Meanwhile the 587x artifact above has an average sell
 * price BELOW its average buy price, so the two estimates are orders of
 * magnitude apart. Measured over the 16 suppressed rows of one 500-wallet scan,
 * twelve agreed to within 1% and four were out by 1.27x to 4.01x, so the gap
 * separates them cleanly and this tolerance is deliberately tight.
 */
const MULTIPLE_CORROBORATION_TOLERANCE = 0.1;

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
 * The multiple to display, or null when the basis cannot support one. The PNL
 * stays visible either way — an absent ratio is honest, a 587x is not.
 *
 * Past `MAX_PLAUSIBLE_MULTIPLE_X` a second, independent estimate has to agree:
 * average sell price over average buy price. That ratio comes from prices rather
 * than from the profit figure, so on a genuine early entry the two land on the
 * same number, while a wallet whose tokens arrived by transfer has a tiny basis
 * inflating one of them and not the other. The basis must also clear
 * `MIN_COST_BASIS_USD` — corroboration says a big multiple is arithmetically
 * sound, not that $48 of dust is a position worth reporting a return on.
 */
export function displayMultiple(
  pnlUsd: number,
  basisUsd: number,
  priceMultipleX?: number
): number | null {
  if (!Number.isFinite(pnlUsd) || !Number.isFinite(basisUsd) || basisUsd <= 0) return null;
  const x = 1 + pnlUsd / basisUsd;
  if (x <= MAX_PLAUSIBLE_MULTIPLE_X) return x;

  if (basisUsd < MIN_COST_BASIS_USD) return null;
  if (priceMultipleX === undefined || !Number.isFinite(priceMultipleX) || priceMultipleX <= 0) {
    return null;
  }
  // Symmetric: either estimate being the larger one is equally suspicious.
  const disagreement = Math.abs(Math.log(priceMultipleX / x));
  return disagreement <= MULTIPLE_CORROBORATION_TOLERANCE ? x : null;
}

/** True when a result is worth storing or tagging. */
export function meetsQualityBar(multipleX: number | null, pnlUsd: number | null): boolean {
  if (multipleX === null || pnlUsd === null) return false;
  if (!Number.isFinite(multipleX) || !Number.isFinite(pnlUsd)) return false;
  return multipleX >= MIN_WALLET_MULTIPLE_X && pnlUsd >= MIN_WALLET_PNL_USD;
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
