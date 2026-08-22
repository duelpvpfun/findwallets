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
 * Above this share of the wallets in the window having already sold, the step
 * does not reach Telegram. The owner's rule, 2026-08-22: "if >60% of smart
 * wallets sold don't fire — BOTFIRM has 21 smart wallets in but 17 of 21 sold,
 * so useless."
 *
 * Set to 1 to disable. The suppressed step is still claimed, still on the feed
 * and still tracked, which is deliberate: measured against the first night of
 * live data this rule is a 13% cut in messages that silences exactly one call,
 * and the steps it removes had a HIGHER 2x rate (8 of 32) than the steps where
 * nobody had sold (16 of 110). Sold-share rises with time and with the wallet
 * count, so it partly measures "this call ran and people took profit" — BOTFIRM
 * itself went on to peak at 3.85x. Keeping the suppressed steps in the record is
 * the only way to find out whether the threshold is doing what it is meant to.
 */
export const MAX_SOLD_SHARE = envNumber("ALERTS_MAX_SOLD_SHARE", 0.6);

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
 * Slack subtracted from the due threshold, and it fixes a real bug.
 *
 * The cron fires every 10 minutes and the check was "more than 600 seconds
 * since the last one". A token checked at 04:10:04 is only 9m56s old at the
 * 04:20:00 tick, so it was skipped and waited for 04:30 — and it is not random:
 * the sweep walks tokens sequentially, so every token is checked some seconds
 * past the tick and then misses the next one. Measured on $Link the gaps were
 * 18, 22, 19 and 19 minutes against a configured ten.
 *
 * Two minutes is comfortably more than a sweep can drift and comfortably less
 * than the cron period, so a token is always due on the next tick and can never
 * be sampled twice in one.
 */
export const SAMPLE_DUE_SLACK_SECONDS = 120;

/**
 * Tokens whose peak is reconciled against candle data per sweep.
 *
 * The rotation, not a schedule. Sized by wall clock rather than by the rate
 * limit: measured against the live API a check costs ~5s once the pool is
 * cached and ~10s when it is not, almost all of it the throttle plus network
 * latency. 25 therefore lands around 125s, comfortably inside the pass's 200s
 * budget, and reconciles ~200 tracked tokens roughly every 80 minutes.
 *
 * It can afford to be lazy because **a candle high cannot be missed by looking
 * late**: a spike at 04:29 is in the 04:29 candle forever. Cadence buys display
 * freshness here, never correctness, which is the opposite of how the spot
 * sampling behaves.
 */
export const PEAK_CHECKS_PER_SWEEP = envNumber("ALERTS_PEAK_CHECKS_PER_SWEEP", 25);

/**
 * How far above the best OBSERVED spot market cap a candle peak may sit before
 * it is rejected as a bad read.
 *
 * This is a safety gate, not a tuning knob. Candle data lands on the public
 * podium and in the pinned Telegram message with no human in between, so a
 * wrong read is not an imprecise number, it is a fabricated one — $ELOTÉ read
 * **8,334,654x** because its deepest pool is "ZEC / ELOTÉ" and the OHLCV
 * endpoint defaults to the pool's base token, handing us ZEC at $834 a unit.
 * That specific bug is fixed by naming the token in the request; this exists
 * because the next one will be different and must not reach a reader.
 *
 * 20x is deliberately loose. The whole point of candles is to catch peaks that
 * spot sampling missed, and the biggest real gap measured so far is $Link at
 * 1.9x its best spot sample — so 20x rejects nonsense by orders of magnitude
 * while never touching a genuine correction. Spot samples come from a different
 * provider on a different code path, which is what makes them a real check
 * rather than the same number twice.
 */
export const MAX_CANDLE_JUMP_X = envNumber("ALERTS_MAX_CANDLE_JUMP_X", 20);

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

/**
 * The pinned leaderboard: how far back it looks, and how many calls it shows.
 *
 * **The last hour, refreshed hourly — the owner's call, 2026-08-22.** It shipped
 * on a rolling 24 hours, which made it the same three calls as the 2pm recap
 * for most of the day: the pin is edited silently in place, so a reader saw one
 * board that never appeared to change and a daily post that told them what they
 * had already read. Two messages, one fact.
 *
 * An hour restores the division of labour. The pin is what is happening now and
 * earns its refresh; the recap is the day, and is the only place a 24-hour
 * ranking appears. A quiet hour says so rather than reaching back for an older
 * call — see `buildLeaderboardMessage`, which never widens its own window.
 *
 * Three, because the pin has to stay short enough that Telegram does not
 * collapse it behind "show more" in the header preview.
 */
export const PIN_WINDOW_HOURS = envNumber("ALERTS_PIN_WINDOW_HOURS", 1);
export const PIN_TOP_N = envNumber("ALERTS_PIN_TOP_N", 3);

/**
 * A call needs an entry cap this high before it can appear on the pin.
 *
 * Same bar as the scoreboard, and for the same reason: a $3K cap doubling is
 * one buy, and a leaderboard is exactly where an unearned multiple does the
 * most damage — it is the number we are asking a stranger to trust.
 */
export const PIN_MIN_MCAP_USD = MIN_SCOREBOARD_MCAP_USD;

/**
 * The daily recap: one post a day at 2pm, the owner's call (2026-08-22).
 *
 * Separate from the pin on purpose. The pin is what a stranger who opens the
 * channel reads and it rewrites itself silently every hour; the recap is a real
 * post that notifies, aimed at subscribers who already scrolled past today's
 * alerts and want to know which of them went anywhere. Same numbers, different
 * job, so different knobs.
 *
 * **Local time, not a fixed UTC hour.** The owner said "2PM EST", which is New
 * York time rather than the literal UTC-5 offset — and a cron expression cannot
 * express that, because America/New_York is UTC-4 for two thirds of the year.
 * A fixed `0 19 * * *` would post at 3pm all summer. So the route runs every
 * hour and posts only when the local hour matches, which is exact year-round
 * and needs no DST edit twice a year.
 */
export const DIGEST_HOUR_LOCAL = envNumber("ALERTS_DIGEST_HOUR_LOCAL", 14);
export const DIGEST_TZ = process.env.ALERTS_DIGEST_TZ || "America/New_York";

/**
 * Fixed at 24 hours, not borrowed from `PIN_WINDOW_HOURS`.
 *
 * The recap is the day's calls by definition, so it must not silently follow a
 * change made to shorten the pin's window.
 */
export const DIGEST_WINDOW_HOURS = 24;
export const DIGEST_TOP_N = envNumber("ALERTS_DIGEST_TOP_N", 3);

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
  /**
   * Logo asset under `public/venues/`.
   *
   * Self-hosted, never hotlinked. A third-party favicon leaks a referrer on
   * every row of the feed and breaks silently the moment they move the file,
   * which is why this started life as a monogram. The fix is to own the bytes,
   * not to go without the logo.
   */
  slug: string;
  chains: Chain[];
  /**
   * Env var holding the referral code, or null for a venue we earn nothing on.
   *
   * pump.fun has no referral programme and is here regardless: it is where a
   * pump.fun token actually trades, and losing a commission is not a reason to
   * send a buyer somewhere worse.
   */
  refEnv: string | null;
  /** The chain is passed in rather than inferred from the address. Inferring it
   * cost a real bug: `0x` is true of both EVM chains, so a Base alert linked to
   * GMGN's BNB Chain page for the same address — a live page, for a different
   * token. Nothing here may guess a chain it is already being told. */
  withRef: ((chain: Chain, address: string, ref: string) => string) | null;
  plain: (chain: Chain, address: string) => string;
}

export const TRADE_LINKS: TradeLink[] = [
  {
    name: "Axiom",
    slug: "axiom",
    chains: ["solana"],
    refEnv: "ALERTS_REF_AXIOM",
    withRef: (_chain, mint, ref) => `https://axiom.trade/t/${mint}/@${ref}`,
    plain: (_chain, mint) => `https://axiom.trade/t/${mint}`,
  },
  {
    name: "Trojan",
    slug: "trojan",
    chains: ["solana"],
    refEnv: "ALERTS_REF_TROJAN",
    withRef: (_chain, mint, ref) => `https://t.me/solana_trojanbot?start=r-${ref}-${mint}`,
    plain: (_chain, mint) => `https://t.me/solana_trojanbot?start=${mint}`,
  },
  {
    // GMGN covers all three chains off one referral code, which is why it is
    // the chart link rather than Dexscreener on the paid rows.
    name: "GMGN",
    slug: "gmgn",
    chains: ["solana", "bsc", "base"],
    refEnv: "ALERTS_REF_GMGN",
    withRef: (chain, address, ref) => `https://gmgn.ai/${GMGN_CHAIN_SLUG[chain]}/token/${ref}_${address}`,
    plain: (chain, address) => `https://gmgn.ai/${GMGN_CHAIN_SLUG[chain]}/token/${address}`,
  },
  {
    // Replaced BasedBot, 2026-08-22, the owner's call. No referral programme
    // and none expected — it earns its place by being the venue the token is
    // actually on. Almost every call in this feed is a pump.fun launch, so for
    // most readers this is the shortest path from alert to filled order, and a
    // link we make nothing on beats a link nobody taps.
    //
    // Solana only. There is no pump.fun page for a BNB Chain or Base contract,
    // and a dead link on an alert is worse than one fewer button.
    name: "pump.fun",
    slug: "pumpfun",
    chains: ["solana"],
    refEnv: null,
    withRef: null,
    plain: (_chain, mint) => `https://pump.fun/coin/${mint}`,
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
