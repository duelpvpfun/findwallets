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
  { wallets: 2, windowSeconds: 120, label: "2 wallets", kind: "burst" },
  { wallets: 3, windowSeconds: 300, label: "3 wallets", kind: "burst" },
  { wallets: 4, windowSeconds: 3600, label: "4 wallets", kind: "cluster" },
  { wallets: 5, windowSeconds: 3600, label: "5 wallets", kind: "cluster" },
  { wallets: 6, windowSeconds: 3600, label: "6 wallets", kind: "cluster" },
  { wallets: 8, windowSeconds: 3600, label: "8 wallets", kind: "accumulation" },
  { wallets: 10, windowSeconds: 3600, label: "10 wallets", kind: "accumulation" },
  { wallets: 15, windowSeconds: 3600, label: "15 wallets", kind: "accumulation" },
  { wallets: 20, windowSeconds: 3600, label: "20 wallets", kind: "accumulation" },
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
function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export const MIN_BUY_USD = envNumber("ALERTS_MIN_BUY_USD", 50);

/**
 * The alerting band. A call only fires while the token's market cap is inside
 * it — the owner's rule, 2026-08-21.
 *
 * Below $10K a single buy moves the chart and the "multiple" measures nothing.
 * Above $1M the wallets are no longer early and the reader cannot get the entry
 * they did. Between the two is the only range where the signal is both real and
 * actionable, and cutting to it removes most of the noise on its own.
 *
 * Checked at the moment a tier fires, against the cap right then. That is what
 * makes the rule behave as intended: two wallets in at $5K is skipped, and when
 * a third buys at $11K that step fires — with $11K as the entry, because $5K is
 * a price nobody was told about.
 */
export const MIN_ALERT_MCAP_USD = envNumber("ALERTS_MIN_MCAP_USD", 10_000);
export const MAX_ALERT_MCAP_USD = envNumber("ALERTS_MAX_MCAP_USD", 1_000_000);

/**
 * A token whose market cap has fallen below this is abandoned: no more samples.
 *
 * Most of these go to zero and stay there, so re-reading them every ten minutes
 * for a week is the bulk of the tracking spend for no information. The trade is
 * explicit and the owner's: a coin that dies below $4K and then somehow runs is
 * missed. Not once-and-for-all — the check is on the last cap we saw, so a token
 * that never gets that low keeps being tracked normally.
 */
export const DEAD_MCAP_USD = envNumber("ALERTS_DEAD_MCAP_USD", 4_000);

/**
 * Lowest tier that reaches Telegram. Everything in-band still lands on the feed.
 *
 * **Off by default (0).** The band above is the volume control the owner chose;
 * this stays as a second lever in case it is not enough.
 */
export const TELEGRAM_MIN_TIER = envNumber("ALERTS_TELEGRAM_MIN_TIER", 0);

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
 * window, not an archive, and unpruned it is 60k-500k rows a day. */
export const EVENT_RETENTION_HOURS = 48;

/**
 * How long a call's market cap keeps getting sampled.
 *
 * Seven days. The peak of a memecoin run is almost always inside 48 hours, and
 * every extra day is another price call per still-open call. Tokens are
 * deduplicated, so the cost is per token rather than per call — and a token
 * that falls under `DEAD_MCAP_USD` is dropped before the week is up.
 */
export const TRACKING_DAYS = 7;

/**
 * How often a token's market cap is re-read, by how old the call is.
 *
 * Ten minutes for the first 24 hours, then hourly. A memecoin's peak is almost
 * always inside the first day, and a running maximum is only as good as the
 * sampling rate around it — but ten-minute resolution for a full week would be
 * six times the upstream cost for detail nobody looks at.
 */
export const FRESH_SAMPLE_SECONDS = 10 * 60;
export const AGED_SAMPLE_SECONDS = 60 * 60;

/**
 * Cap on the stored series: the dense first day (six an hour) plus six more
 * days hourly, plus the alert-time sample. Enough to draw the whole tracked
 * life of a call at the resolution it was actually measured.
 */
export const MAX_SAMPLES = 24 * 6 + (TRACKING_DAYS - 1) * 24 + 1;

/**
 * Below this, a market cap is too thin for a multiple to mean anything — a $3K
 * cap doubling is one buy, not a call working. Kept as a scoreboard filter even
 * though the alerting band now starts higher, so historical calls from before
 * the band are scored on the same footing.
 */
export const MIN_SCOREBOARD_MCAP_USD = 10_000;

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
    // Deep-links per token, same as the others. The referral code goes on as
    // `?ref=`, which is the convention but is NOT confirmed for this host —
    // Cloudflare blocks any request that could verify it. A wrong parameter is
    // ignored rather than broken, so the risk is silently losing commission,
    // not a dead link. Confirm it attaches, and if the parameter has another
    // name this is a one-word change.
    name: "BasedBot",
    chains: ["solana", "bsc", "base"],
    refEnv: "ALERTS_REF_BASEDBOT",
    withRef: (chain, address, ref) =>
      `https://basedbot.app/token/${BASEDBOT_CHAIN_SLUG[chain]}/${address}?ref=${ref}`,
    plain: (chain, address) => `https://basedbot.app/token/${BASEDBOT_CHAIN_SLUG[chain]}/${address}`,
  },
];

const GMGN_CHAIN_SLUG: Record<Chain, string> = { solana: "sol", bsc: "bsc", base: "base" };
const BASEDBOT_CHAIN_SLUG: Record<Chain, string> = { solana: "sol", bsc: "bsc", base: "base" };

/** The buttons for one chain, in display order. */
export function tradeLinksFor(chain: Chain): TradeLink[] {
  return TRADE_LINKS.filter((link) => link.chains.includes(chain));
}

const DEXSCREENER_SLUG: Record<Chain, string> = { solana: "solana", bsc: "bsc", base: "base" };

export function dexScreenerUrl(chain: Chain, address: string): string {
  return `https://dexscreener.com/${DEXSCREENER_SLUG[chain]}/${address}`;
}


/**
 * Whether `/alerts` and its feed are public.
 *
 * Off by default, which makes the page owner-only: it renders exactly as it
 * will in public, behind the same admin cookie as `/admin`, so what gets
 * reviewed is the real thing rather than a preview of it. Flipping
 * `ALERTS_PUBLIC=1` ships it — no code change, no redeploy of anything else,
 * and no chance of the switch and the page disagreeing.
 *
 * The gate has to cover the API as well as the page. A private page served by a
 * public JSON endpoint is a public page with extra steps.
 */
export function alertsArePublic(): boolean {
  return process.env.ALERTS_PUBLIC === "1";
}
