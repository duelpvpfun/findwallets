import { createRng, pick, randRange, randomBase58Address } from "./rng";
import { realizedBasisUsd } from "./quality";
import type { Chain, TokenMeta, WalletDetail, WalletTrader } from "./types";

// Fallback data used only when SOLANA_TRACKER_API_KEY is not configured, so the
// UI stays usable during setup. Deterministic per-CA (same input -> same output).
// Real data comes from src/lib/solanaTracker.ts once a key is set.

const NICKNAMES = [
  "grandpa",
  "ghost",
  "wraith",
  "sensei",
  "nova",
  "kaiju",
  "vortex",
  "wizard",
  "cobra",
  "falcon",
  "phantom",
  "oracle",
  "sniper",
  "reaper",
  "titan",
  null,
  null,
  null,
  null,
  null,
];

const TOKEN_NAME_ADJ = [
  "Apollo",
  "Wagmi",
  "Moonpup",
  "Solking",
  "Ratio",
  "Chadcoin",
  "Doggo",
  "Based",
  "Nitro",
  "Turbo",
];

function isLikelyToken2022(address: string): boolean {
  return createRng(address + ":ext")() > 0.8;
}

export function buildTokenMeta(address: string, chain: Chain = "solana"): TokenMeta {
  const rng = createRng(address);
  const name = pick(rng, TOKEN_NAME_ADJ);
  const priceUsd = randRange(rng, 0.000001, 0.05);
  const marketCapUsd = randRange(rng, 20_000, 8_000_000);
  const source = rng() > 0.5 ? "pumpfun" : "raydium";
  return {
    chain,
    address,
    name,
    symbol: name.slice(0, 4).toUpperCase(),
    imageUrl: null,
    priceUsd,
    marketCapUsd,
    estimatedSupply: priceUsd > 0 ? marketCapUsd / priceUsd : 0,
    nativePriceUsd: chain === "solana" ? randRange(rng, 100, 250) : randRange(rng, 400, 800),
    isToken2022: chain === "solana" && isLikelyToken2022(address),
    source: chain === "solana" ? source : "other",
    market: chain === "solana" ? source : null,
    rankingWindow: chain === "solana" ? "all_time" : "90d",
  };
}

function buildTrader(address: string, rank: number, rng: () => number): WalletTrader {
  const boughtTokenAmount = randRange(rng, 5_000, 5_000_000);
  const avgBuyPriceUsd = randRange(rng, 0.0000005, 0.02);
  const boughtUsd = boughtTokenAmount * avgBuyPriceUsd;

  const isHolding = rng() < 0.15;
  const soldFraction = isHolding ? randRange(rng, 0, 0.4) : randRange(rng, 0.6, 1);
  const soldTokenAmount = boughtTokenAmount * soldFraction;

  // Winners (top of the list) skew toward buying low & selling high.
  const winFactor = Math.max(0, (250 - rank) / 250);
  const sellMultiplier = 1 + winFactor * randRange(rng, 1.5, 12) + randRange(rng, -0.3, 0.5);
  const avgSellPriceUsd = Math.max(avgBuyPriceUsd * 0.05, avgBuyPriceUsd * sellMultiplier);
  const soldUsd = soldTokenAmount * avgSellPriceUsd;

  const costBasisOfSold = soldTokenAmount * avgBuyPriceUsd;
  const realizedPnlUsd = soldUsd - costBasisOfSold;
  // Realized over the sold lots' own basis, matching both live adapters. Demo
  // numbers on a different basis made the sample table disagree with a paid scan.
  const realizedBasis = realizedBasisUsd(costBasisOfSold, boughtUsd);
  const realizedPnlPercent = realizedBasis > 0 ? (realizedPnlUsd / realizedBasis) * 100 : 0;
  const avgMultipleX = realizedBasis > 0 ? 1 + realizedPnlUsd / realizedBasis : 0;

  // Mock wallets have no transfers or airdrops, so the leftover balance is
  // exactly bought minus sold -- the quantity the live path reads off-chain.
  const remainingTokens = Math.max(0, boughtTokenAmount - soldTokenAmount);
  const remainingPercent =
    boughtTokenAmount > 0 ? Math.min(100, (remainingTokens / boughtTokenAmount) * 100) : 0;
  const remainingValueUsd = remainingTokens * avgSellPriceUsd;

  const now = Date.now();
  const estimatedSupply = randRange(rng, 500_000_000, 1_000_000_000);
  const tags: string[] = rng() < 0.05 ? ["kol"] : rng() < 0.08 ? ["bot"] : [];

  return {
    rank,
    address,
    nickname: pick(rng, NICKNAMES),
    twitter: tags.includes("kol") ? "@" + randomBase58Address(rng, 6).toLowerCase() : null,
    tags,
    avgBuyPriceUsd,
    avgSellPriceUsd,
    avgBuyMcapUsd: avgBuyPriceUsd * estimatedSupply,
    avgSellMcapUsd: avgSellPriceUsd * estimatedSupply,
    buyTxns: Math.floor(randRange(rng, 1, 40)),
    sellTxns: Math.floor(randRange(rng, 1, 35)),
    boughtTokenAmount,
    soldTokenAmount,
    boughtUsd,
    soldUsd,
    soldCostBasisUsd: costBasisOfSold,
    realizedPnlUsd,
    realizedPnlPercent,
    avgMultipleX,
    remainingPercent,
    remainingValueUsd,
    isHolding,
    unrealizedPnlUsd: isHolding ? remainingValueUsd * randRange(rng, -0.3, 1.2) : 0,
    lastTradeMs: now - randRange(rng, 0.2, 240) * 3_600_000,
    firstTradeMs: now - randRange(rng, 1, 400) * 86_400_000,
    walletLifetimeRealizedPnlUsd: randRange(rng, -50_000, 500_000),
    walletLifetimeTotalTrades: Math.floor(randRange(rng, 50, 20_000)),
    walletLifetimeTokensTraded: Math.floor(randRange(rng, 10, 3_000)),
  };
}

export function buildTopTraders(
  address: string,
  limit: number,
  chain: Chain = "solana"
): { token: TokenMeta; traders: WalletTrader[] } {
  const token = buildTokenMeta(address, chain);
  const rng = createRng(address + ":traders");
  const traders: WalletTrader[] = [];

  for (let i = 1; i <= limit; i++) {
    const walletAddress = randomBase58Address(rng);
    traders.push(buildTrader(walletAddress, i, rng));
  }

  traders.sort((a, b) => b.realizedPnlUsd - a.realizedPnlUsd);
  traders.forEach((t, idx) => (t.rank = idx + 1));

  return { token, traders };
}

export function buildWalletDetail(tokenAddress: string, trader: WalletTrader): WalletDetail {
  const rng = createRng(tokenAddress + ":" + trader.address + ":detail");

  const totalValueUsd = randRange(rng, 100, 5000);
  const unrealizedPnlUsd = trader.isHolding ? randRange(rng, -500, 3000) : 0;
  const estimatedSupply = trader.avgBuyPriceUsd > 0 ? trader.avgBuyMcapUsd / trader.avgBuyPriceUsd : 0;

  const activity: WalletDetail["activity"] = [];
  let timeMs = Date.now() - Math.floor(randRange(rng, 5, 60)) * 60_000;
  for (let i = 0; i < 8; i++) {
    const type: "Buy" | "Sell" = i % 2 === 0 ? "Sell" : "Buy";
    const amountTokens = randRange(rng, 0.5, 3);
    const priceUsd = randRange(rng, 0.000001, 0.05);
    activity.push({
      type,
      amountTokens,
      amountUsd: amountTokens * priceUsd * 1000,
      priceUsd,
      mcapUsd: priceUsd * estimatedSupply,
      timeMs,
      txSignature: randomBase58Address(rng, 12) + i,
    });
    timeMs -= Math.floor(randRange(rng, 1, 90)) * 60_000;
  }

  return {
    address: trader.address,
    twitter: trader.twitter,
    tags: trader.tags,
    totalValueUsd,
    nativeBalance: randRange(rng, 0.1, 30),
    walletRealizedPnlUsd: trader.walletLifetimeRealizedPnlUsd ?? trader.realizedPnlUsd,
    walletUnrealizedPnlUsd: unrealizedPnlUsd,
    winRatePercent: randRange(rng, 30, 85),
    avgPnlPerAssetUsd: randRange(rng, -500, 5000),
    avgBuyValueUsd: randRange(rng, 100, 3000),
    tokensClosed: Math.floor(randRange(rng, 10, 400)),
    tokensWinning: Math.floor(randRange(rng, 5, 200)),
    tokensLosing: Math.floor(randRange(rng, 5, 200)),
    isArbitrage: false,
    platforms: rng() < 0.3 ? ["axiom"] : [],
    distribution: [
      { label: ">500%", count: Math.floor(randRange(rng, 0, 4)) },
      { label: "200-500%", count: Math.floor(randRange(rng, 0, 5)) },
      { label: "0-200%", count: Math.floor(randRange(rng, 2, 14)) },
      { label: "-50-0%", count: Math.floor(randRange(rng, 5, 35)) },
      { label: "<-50%", count: Math.floor(randRange(rng, 0, 10)) },
    ],
    topPositions: Array.from({ length: 5 }, () => {
      const avgBuyPriceUsd = randRange(rng, 0.0000005, 0.02);
      const multipleX = randRange(rng, 1.2, 25);
      const investedUsd = randRange(rng, 200, 20_000);
      const proceedsUsd = investedUsd * multipleX;
      return {
        tokenAddress: randomBase58Address(rng),
        symbol: pick(rng, TOKEN_NAME_ADJ).slice(0, 4).toUpperCase(),
        realizedPnlUsd: proceedsUsd - investedUsd,
        roiPercent: (multipleX - 1) * 100,
        investedUsd,
        proceedsUsd,
        avgBuyPriceUsd,
        avgSellPriceUsd: avgBuyPriceUsd * multipleX,
        multipleX,
        tradeCount: Math.floor(randRange(rng, 2, 80)),
        holdTimeSecs: randRange(rng, 60, 800_000),
        lastTradeMs: Date.now() - randRange(rng, 1, 200) * 86_400_000,
      };
    }).sort((a, b) => b.realizedPnlUsd - a.realizedPnlUsd),
    positionsHolding: Math.floor(randRange(rng, 1, 20)),
    positionsSold: Math.floor(randRange(rng, 10, 400)),
    avgHoldTimeSecs: randRange(rng, 60, 500_000),
    activity,
    isDemoData: true,
  };
}
