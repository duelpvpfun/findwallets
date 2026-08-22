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
 * How far the tokens sold may exceed the tokens bought before the cost basis is
 * treated as incomplete. A little slack absorbs rounding and decimals drift.
 */
const SOLD_COVERAGE_TOLERANCE = 1.02;

/**
 * Whether a wallet's cost basis actually covers what it sold.
 *
 * THIS REPLACED A CEILING ON THE MULTIPLE ITSELF, and the distinction matters.
 * The old rule was "above 500x it is an artifact", which is not a property of a
 * trade — it is a property of how big the number is. It suppressed a wallet that
 * turned $299 into $204K while the entry and exit market caps on the same row
 * read $34.8K → $23.75M, i.e. 682x: the row was calling its own numbers
 * implausible. Three more on one scan bought 10-19M tokens for $48-$212 and sold
 * a fraction of them for six figures. Real early entries, every one, hidden for
 * being large.
 *
 * What the ceiling was really groping for is untracked inventory. The original
 * artifact — ONE $39.46 buy and 225 sells of 15.95M tokens — is not suspicious
 * because 587x is big; it is suspicious because it SOLD FAR MORE TOKENS THAN IT
 * BOUGHT, so most of what it sold arrived by transfer or airdrop and has no
 * recorded cost. There is nothing to divide by, at any size of multiple.
 *
 * That test is exact, it is about the trade rather than the magnitude, and a
 * small basis is no longer evidence of anything: $48 spent on 19M tokens is a
 * real position when 15M of those tokens are what got sold.
 */
export function basisCoversSold(soldTokenAmount: number, boughtTokenAmount: number): boolean {
  if (!Number.isFinite(soldTokenAmount) || !Number.isFinite(boughtTokenAmount)) return false;
  if (boughtTokenAmount <= 0) return false;
  return soldTokenAmount <= boughtTokenAmount * SOLD_COVERAGE_TOLERANCE;
}

/**
 * Denominator for a realized return: the cost of the tokens actually sold.
 *
 * The dust fallback to total buy volume is now conditional on the sold quantity
 * NOT being covered by the bought quantity, and that fixes a real distortion.
 * A wallet that bought 17.5M tokens for $115 and sold 5.1M of them has a sold
 * basis of $33.50 — small, but exactly right, and it produces 18,896x against a
 * price-implied 19,023x. Charging the whole $115 to that 29% instead returned
 * 5,509x: a third of the truth, for a wallet whose own entry and exit prices
 * said otherwise. When the tokens ARE covered, however few dollars they cost,
 * the sold basis is the honest denominator.
 */
export function realizedBasisUsd(
  soldCostBasisUsd: number,
  boughtUsd: number,
  covered = false
): number {
  if (covered || soldCostBasisUsd >= MIN_COST_BASIS_USD) return soldCostBasisUsd;
  return Math.max(soldCostBasisUsd, boughtUsd);
}

/**
 * The multiple to display, or null when there is no basis to divide by.
 *
 * No ceiling, and no floor on the basis in dollars. A 600x is not evidence of a
 * bad number, and neither is a $48 cost — 19M tokens bought for $48 and 15M of
 * them sold for $502K is a real trade, and the old rules called it an artifact
 * twice over. `basisCoversSold` at the call site decides only WHICH denominator
 * is right, never whether to show one. The single remaining n/a case is a wallet
 * with no recorded buy at all, where there is genuinely nothing to divide by.
 */
export function displayMultiple(pnlUsd: number, basisUsd: number): number | null {
  if (!Number.isFinite(pnlUsd) || !Number.isFinite(basisUsd) || basisUsd <= 0) return null;
  const x = 1 + pnlUsd / basisUsd;
  return Number.isFinite(x) ? x : null;
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
