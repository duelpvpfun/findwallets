import type { Chain } from "../types";
/**
 * Every tunable the alert engine has. No `server-only` marker: the /alerts page
 * renders the same tier labels the Telegram message uses, and duplicating them
 * into the client bundle is how the two drift apart.
 *
 * Nothing here reads a secret. Anything that does lives in `telegram.ts` or the
 * route that needs it.
 */

/** One escalation step: N distinct wallets buying inside `windowSeconds`. */
export interface AlertTier {
  wallets: number;
  windowSeconds: number;
  /** Short, for a badge. */
  label: string;
  /** How urgent the shape is, for colour and copy. */
  kind: "burst" | "cluster" | "accumulation";
}

/**
 * The owner's rules, 2026-08-21, in his words: two wallets in two minutes,
 * three in five, four or more within the hour.
 *
 * The first two are a *burst* — wallets landing on the same token within
 * minutes of each other, which is either shared information or the same signal
 * being read by several good traders. The hour-long tiers are *accumulation*:
 * slower, but four independent winners is a much stronger claim than two.
 *
 * Above 6 the steps double rather than increment. A genuinely viral token would
 * otherwise post 7, 8, 9, 10 … into the channel one message at a time, and the
 * marginal information in "now 9 wallets" over "now 8 wallets" is nil.
 */
export const ALERT_TIERS: AlertTier[] = [
  { wallets: 2, windowSeconds: 120, label: "2 in 2m", kind: "burst" },
  { wallets: 3, windowSeconds: 300, label: "3 in 5m", kind: "burst" },
  { wallets: 4, windowSeconds: 3600, label: "4 in 1h", kind: "cluster" },
  { wallets: 5, windowSeconds: 3600, label: "5 in 1h", kind: "cluster" },
  { wallets: 6, windowSeconds: 3600, label: "6 in 1h", kind: "cluster" },
  { wallets: 8, windowSeconds: 3600, label: "8 in 1h", kind: "accumulation" },
  { wallets: 10, windowSeconds: 3600, label: "10 in 1h", kind: "accumulation" },
  { wallets: 15, windowSeconds: 3600, label: "15 in 1h", kind: "accumulation" },
  { wallets: 20, windowSeconds: 3600, label: "20 in 1h", kind: "accumulation" },
];

/** Distinct window lengths, longest first — the shape the window query wants. */
export const ALERT_WINDOWS_SECONDS: number[] = [
  ...new Set(ALERT_TIERS.map((t) => t.windowSeconds)),
].sort((a, b) => b - a);

export const LONGEST_WINDOW_SECONDS = ALERT_WINDOWS_SECONDS[0];

export function tierFor(wallets: number): AlertTier | undefined {
  return ALERT_TIERS.find((t) => t.wallets === wallets);
}

/**
 * A buy under this doesn't count toward a tier.
 *
 * Set at $50 by the owner. It is not about the money — it is about intent: good
 * wallets routinely send a dust buy to test a token's transfer tax or honeypot
 * behaviour before committing, and three of those inside two minutes is a
 * false alert, not a signal.
 */
export const MIN_BUY_USD = 50;

/**
 * How long a token must go without a single tracked buy before its escalation
 * ladder resets and it can alert from 2 again.
 *
 * Two hours. Shorter and a token that trickles all day re-alerts constantly;
 * much longer and a token that ran this morning stays silent through a genuine
 * second run this evening. The longest tier window is an hour, so two hours is
 * also the shortest gap that guarantees the ladder never resets mid-window.
 */
export const EPISODE_GAP_SECONDS = 2 * 60 * 60;

/** How long `wallet_events` rows survive. Long enough to serve the longest
 * window with room for late-arriving Helius deliveries; this is a rolling
 * window, not an archive, and unpruned it is 60k–500k rows a day. */
export const EVENT_RETENTION_HOURS = 48;

/**
 * How long an alert's market cap keeps getting sampled.
 *
 * Seven days. The peak of a memecoin run is almost always inside 48 hours, and
 * every extra day of tracking is another hourly price call per still-open
 * alert. Tokens are deduplicated across alerts, so tracking cost is per token,
 * not per alert.
 */
export const TRACKING_DAYS = 7;

/** Cap on the stored hourly series: 7 days at one an hour, plus the alert-time
 * sample. Enough to draw the whole tracked life of an alert. */
export const MAX_SAMPLES = TRACKING_DAYS * 24 + 1;

/**
 * Below this, a market cap is too thin for the multiple to mean anything — a
 * $3K cap doubling is one buy, not a call working. Alerts still fire and still
 * track; they are just excluded from the tier averages on the scoreboard.
 */
export const MIN_SCOREBOARD_MCAP_USD = 20_000;

/** Quote assets. A token leg paired against one of these is a trade; a token
 * moving with no quote leg at all is a transfer or an airdrop and must never
 * count as a buy. */
export const WSOL_MINT = "So11111111111111111111111111111111111111112";
export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const USDT_MINT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";

/** Mints that are never the *subject* of an alert, only ever the other side. */
export const QUOTE_MINTS = new Set([WSOL_MINT, USDC_MINT, USDT_MINT]);

/** Dollar-pegged quote mints, worth exactly their token amount. */
export const STABLE_MINTS = new Set([USDC_MINT, USDT_MINT]);

/** Liquid-staking and bluechip mints that pass the quote test but are not
 * memecoin calls. Alerting on somebody rebalancing into JitoSOL is noise. */
export const IGNORED_SUBJECT_MINTS = new Set([
  WSOL_MINT,
  USDC_MINT,
  USDT_MINT,
  "mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So", // mSOL
  "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn", // jitoSOL
  "bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1", // bSOL
  "7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs", // ETH (Wormhole)
  "3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh", // WBTC (Wormhole)
]);

/**
 * Referral destinations rendered under every alert.
 *
 * Every alert is a revenue opportunity rather than a cost centre, which is what
 * lets the public channel and the /alerts feed stay free.
 *
 * Two rules:
 *
 *  - **A missing ref code falls back to the plain link.** An unset env var
 *    should cost commission, never break the message or dead-end a buyer.
 *  - **Scoped by chain.** The stream is Solana-only today, but the BNB Chain
 *    and Base destinations are configured here rather than in a note somewhere,
 *    so adding those chains is a routing change and not a research task.
 *
 * The deep-link formats for Axiom and GMGN could not be verified automatically
 * — both sit behind Cloudflare, which 403s a plain request even for a URL that
 * is definitely valid. They are the widely-used formats; confirm the ref
 * actually attaches by tapping each button once on a real alert.
 */
export interface TradeLink {
  name: string;
  chains: Chain[];
  /** Env var holding the referral code. */
  refEnv: string;
  /** The chain is passed in rather than inferred from the address. Inferring it
   * cost a real bug: `0x` is true of both EVM chains, so a Base alert linked to
   * GMGN's BNB Chain page for the same address — a live page, for a different
   * token. Nothing here may guess a chain it is already being told. */
  withRef: (chain: Chain, address: string, ref: string) => string;
  plain: (chain: Chain, address: string) => string;
}

export const TRADE_LINKS: TradeLink[] = [
  {
    name: "Axiom",
    chains: ["solana"],
    refEnv: "ALERTS_REF_AXIOM",
    withRef: (_chain, mint, ref) => `https://axiom.trade/t/${mint}/@${ref}`,
    plain: (_chain, mint) => `https://axiom.trade/t/${mint}`,
  },
  {
    name: "Trojan",
    chains: ["solana"],
    refEnv: "ALERTS_REF_TROJAN",
    withRef: (_chain, mint, ref) => `https://t.me/solana_trojanbot?start=r-${ref}-${mint}`,
    plain: (_chain, mint) => `https://t.me/solana_trojanbot?start=${mint}`,
  },
  {
    // GMGN covers all three chains off one referral code, which is why it is
    // the chart link rather than Dexscreener on the paid rows.
    name: "GMGN",
    chains: ["solana", "bsc", "base"],
    refEnv: "ALERTS_REF_GMGN",
    withRef: (chain, address, ref) => `https://gmgn.ai/${GMGN_CHAIN_SLUG[chain]}/token/${ref}_${address}`,
    plain: (chain, address) => `https://gmgn.ai/${GMGN_CHAIN_SLUG[chain]}/token/${address}`,
  },
  {
    // The only destination with no per-token deep link: `basedbot.app/r/<ref>`
    // is a referral landing page, so a buyer arrives at the app rather than at
    // the coin. That is why it sits last, and why the "Copy contract" button is
    // first — the contract is already on their clipboard when they land.
    // Replace both forms the moment a per-token URL is known.
    //
    // Listed on all three chains: the app is Base-first (its root redirects to
    // /base) but exposes ETH, SOL and BNB, and a referral landing page is
    // chain-agnostic anyway.
    name: "BasedBot",
    chains: ["solana", "bsc", "base"],
    refEnv: "ALERTS_REF_BASEDBOT",
    withRef: (_chain, _address, ref) => `https://basedbot.app/r/${ref}`,
    plain: () => `https://basedbot.app`,
  },
];

const GMGN_CHAIN_SLUG: Record<Chain, string> = { solana: "sol", bsc: "bsc", base: "base" };

/** The buttons for one chain, in display order. */
export function tradeLinksFor(chain: Chain): TradeLink[] {
  return TRADE_LINKS.filter((link) => link.chains.includes(chain));
}

const DEXSCREENER_SLUG: Record<Chain, string> = { solana: "solana", bsc: "bsc", base: "base" };

export function dexScreenerUrl(chain: Chain, address: string): string {
  return `https://dexscreener.com/${DEXSCREENER_SLUG[chain]}/${address}`;
}
