import "server-only";
import { SITE_URL } from "../siteUrl";
import { formatUsd } from "../format";
import { dexScreenerUrl, tradeLinksFor, type AlertTier } from "./config";
import type { Chain } from "../types";
import type { AlertWalletSnapshot } from "../db/schema";

/**
 * Telegram delivery.
 *
 * Best-effort by construction: every function here resolves rather than throws,
 * because an alert that cannot be delivered must still be recorded, still show
 * up in the on-site feed, and still have its market cap tracked. A Telegram
 * outage is a delivery failure, not a data loss.
 */

const API_BASE = "https://api.telegram.org";

/**
 * Where every alert points back to.
 *
 * Resolved through `SITE_URL`, which prefers `NEXT_PUBLIC_SITE_URL` over
 * Vercel's own `VERCEL_PROJECT_PRODUCTION_URL`. That order matters here: Vercel
 * sets the latter to the `*.vercel.app` host automatically, so leaving
 * `NEXT_PUBLIC_SITE_URL` unset would brand every alert with the deploy URL
 * instead of the domain.
 */
function brandUrl(): string {
  return new URL("/feed", SITE_URL).toString();
}

export function isTelegramConfigured(): boolean {
  return Boolean(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_ALERT_CHAT_ID);
}

/** Telegram's HTML mode. Only these three, and they must be escaped before any
 * tag is added — escaping afterwards would eat the tags themselves. */
function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function shorten(address: string): string {
  return address.length <= 12 ? address : `${address.slice(0, 4)}…${address.slice(-4)}`;
}

/** "42s", "4m", "1h 12m" — the real elapsed span, which is what the headline
 * claims, so it has to read naturally at every magnitude. */
function humanSpan(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return rem === 0 ? `${h}h` : `${h}h ${rem}m`;
}

function formatMultiple(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—";
  return value >= 100 ? `${Math.round(value)}x` : `${value.toFixed(1)}x`;
}

/**
 * Escalation you can read without reading.
 *
 * One pip per wallet, coloured by how the confluence formed — green for a
 * two-minute burst, orange for an hour-long cluster, red once it is a crowd.
 * In a channel someone is scrolling past, the LENGTH of this string carries the
 * count before a single word is parsed, which is the only thing that has to
 * land in the first quarter second. Capped so a 20-wallet alert does not wrap.
 */
const KIND_PIP: Record<AlertTier["kind"], string> = {
  burst: "🟢",
  cluster: "🟠",
  accumulation: "🔴",
};

const MAX_PIPS = 6;

function tierPips(tier: AlertTier, count: number): string {
  return KIND_PIP[tier.kind].repeat(Math.min(Math.max(count, 2), MAX_PIPS));
}

export interface AlertMessageInput {
  tier: AlertTier;
  spanSeconds: number;
  chain: Chain;
  tokenAddress: string;
  tokenSymbol: string | null;
  tokenName: string | null;
  mcapUsd: number | null;
  wallets: AlertWalletSnapshot[];
  avgMultipleX: number | null;
  avgPnlUsd: number | null;
  totalBoughtUsd: number;
  exitedCount: number;
  /** Total wallets in the window, which can exceed the wallets listed. */
  walletCount: number;
}

/**
 * The message.
 *
 * Ordered by what a reader decides on, and nothing else gets a line:
 *
 *   1. How many, and how tight — the pips and the headline.
 *   2. The three numbers that size the opportunity, on one line.
 *   3. **Who these wallets are.** This is the entire moat. `Average big wins:
 *      5.8x · $50.2K` comes from our own curated history of what these
 *      wallets have already done, not from the trade that just happened.
 *      Anyone can scrape a mempool and say a wallet bought; nobody else can
 *      say whose wallet it was and what it has done before.
 *   4. The roster, in a quote block so it reads as evidence rather than body
 *      text, and collapses on mobile when it is long.
 *   5. The contract, last, in `<code>` — one tap to copy is how somebody
 *      actually buys, so it must be the easiest thing on screen to hit.
 *
 * The elapsed time is the REAL span between the first and last buy, never the
 * tier's configured window. "in the past 2 minutes" has to be true.
 */
export function buildAlertMessage(input: AlertMessageInput): string {
  const raw = escapeHtml((input.tokenSymbol || "?").replace(/^\$+/, ""));
  // Telegram can only copy the literal contents of a <code> span, so tapping a
  // ticker cannot put the contract on the clipboard. The ticker opens the chart
  // instead, and the "Copy contract" button does the copying.
  const symbol = `<a href="${dexScreenerUrl(input.chain, input.tokenAddress)}">${raw}</a>`;
  const count = input.walletCount;
  const out: string[] = [];

  // The span belongs in the headline, not below it: "3 wallets bought" is a
  // fact, "3 wallets bought inside 40 seconds" is the reason to act. The figure
  // is the REAL first-to-last span, never the tier's configured window — "in
  // the past 2 minutes" has to be true.
  out.push(
    `${tierPips(input.tier, count)} <b>${count} SMART WALLET${count === 1 ? "" : "S"}</b> bought` +
      ` <b>$${symbol}</b> in the past <b>${humanSpan(input.spanSeconds)}</b>`
  );
  if (input.tokenName && input.tokenName.toLowerCase() !== (input.tokenSymbol ?? "").toLowerCase()) {
    out.push(`<i>${escapeHtml(input.tokenName)}</i>`);
  }
  out.push("");

  // Three facts, one line. Three separate labelled lines was more readable on a
  // desktop and worse where it matters, which is a phone in a busy channel.
  const facts = [`💵 <b>${formatUsd(input.totalBoughtUsd)}</b> in`];
  if (input.mcapUsd && input.mcapUsd > 0) facts.push(`📊 <b>${formatUsd(input.mcapUsd)}</b> MC`);
  out.push(facts.join("  ·  "));

  // "Their record" was the wrong words for this number. It is the mean over the
  // wins we have stored for these wallets, not their lifetime performance — the
  // losers are not in `wallet_tokens` at all — so it read as a claim we cannot
  // make and looked inflated to anyone who checked. "Average big wins" is what
  // it has always measured.
  const record: string[] = [];
  if (input.avgMultipleX !== null) record.push(`<b>${formatMultiple(input.avgMultipleX)}</b>`);
  if (input.avgPnlUsd !== null) record.push(`<b>${formatUsd(input.avgPnlUsd)}</b>`);
  if (record.length > 0) out.push(`🏆 <b>Average big wins:</b> ${record.join(" · ")}`);

  // One concrete win beats any average for making a stranger believe the
  // average. A named trader with a 27x on something recognisable is the single
  // most persuasive line in the message.
  const standout = bestWin(input.wallets);
  if (standout) out.push(`⭐ ${standout}`);

  out.push("");
  out.push(walletBlock(input.wallets, count));

  if (input.exitedCount > 0) {
    // Counted toward the tier regardless — the entry is the signal — but
    // burying this would be selling somebody an exit as an entry.
    out.push("");
    out.push(
      `⚠️ <i>${input.exitedCount} of ${count} already sold some back</i>`
    );
  }

  out.push("");
  out.push(`<code>${escapeHtml(input.tokenAddress)}</code>`);
  out.push(`<a href="${brandUrl()}">AlphaWallets.fun</a>`);

  return out.join("\n");
}

/** The loudest single credential in the group, e.g. "cupsey · 27x on $PNUT". */
function bestWin(wallets: AlertWalletSnapshot[]): string | null {
  let best: AlertWalletSnapshot | null = null;
  for (const wallet of wallets) {
    if (wallet.bestMultipleX === null || !wallet.bestSymbol) continue;
    if (best === null || wallet.bestMultipleX > (best.bestMultipleX ?? 0)) best = wallet;
  }
  if (!best || (best.bestMultipleX ?? 0) < 5) return null;

  const who = best.label ? escapeHtml(best.label) : shorten(best.address);
  const ticker = escapeHtml(best.bestSymbol!.replace(/^\$+/, ""));
  return `<b>${who}</b> once did <b>${formatMultiple(best.bestMultipleX!)}</b> on $${ticker}`;
}

/**
 * The roster, as an expandable quote.
 *
 * `expandable` collapses it past a few lines on mobile, which is what keeps a
 * 20-wallet accumulation alert from burying every other message in the channel
 * while still letting anyone who cares open it.
 */
function walletBlock(wallets: AlertWalletSnapshot[], total: number): string {
  const lines = wallets.map((wallet) => {
    const who = wallet.label
      ? `<b>${escapeHtml(wallet.label)}</b>`
      : `<code>${shorten(wallet.address)}</code>`;
    const parts: string[] = [];
    if (wallet.multipleX !== null) parts.push(`${formatMultiple(wallet.multipleX)} avg`);
    parts.push(`${formatUsd(wallet.boughtUsd)} in`);
    const flag = wallet.exited ? " · <i>sold</i>" : "";
    return `${who} — ${parts.join(" · ")}${flag}`;
  });

  // Never a silent truncation: an accumulation alert that lists four of twenty
  // wallets has to say so, or the block reads as the whole picture.
  const withheld = total - wallets.length;
  if (withheld > 0) lines.push(`<i>+ ${withheld} more</i>`);

  const tag = lines.length > 4 ? "<blockquote expandable>" : "<blockquote>";
  return `${tag}${lines.join("\n")}</blockquote>`;
}

/** A url button, or a `copy_text` button — Telegram copies the string to the
 * clipboard on tap, with no bot round trip, which is the only way to make
 * "tap to get the contract" work from a channel post. */
type InlineButton =
  | { text: string; url: string }
  | { text: string; copy_text: { text: string } };

/**
 * The referral row, plus the two links that make the alert useful rather than
 * merely monetised.
 *
 * A missing referral code falls back to the plain link: an unset env var should
 * cost commission, never dead-end a buyer.
 */
export function buildAlertButtons(chain: Chain, tokenAddress: string): InlineButton[][] {
  const trade = tradeLinksFor(chain).map((link) => {
    // `refEnv` is null for a venue with no referral programme (pump.fun), which
    // is not the same as a code we forgot to set. Both fall back to the plain
    // link; only one of them is worth noticing.
    const ref = link.refEnv ? process.env[link.refEnv] : undefined;
    return {
      text: link.name,
      url:
        ref && link.withRef
          ? link.withRef(chain, tokenAddress, ref)
          : link.plain(chain, tokenAddress),
    };
  });

  const rows: InlineButton[][] = [];

  // First, and alone on its row. Copying the contract is the step between
  // reading the alert and owning the coin, so it gets the biggest target on
  // screen. `copy_text` needs no bot round trip and works in a channel.
  rows.push([{ text: "📋 Copy contract", copy_text: { text: tokenAddress } }]);

  // Two per row. Telegram shrinks the label to fit, and three buttons wide
  // stops being tappable on a small phone.
  for (let i = 0; i < trade.length; i += 2) rows.push(trade.slice(i, i + 2));

  rows.push([
    { text: "📈 Chart", url: dexScreenerUrl(chain, tokenAddress) },
    { text: "🔎 Live feed", url: brandUrl() },
  ]);
  return rows;
}

export interface SendResult {
  ok: boolean;
  error: string | null;
  /** Set on success. Stored so the next escalation on the same call can reply
   * to this message instead of arriving as an unrelated post. */
  messageId: number | null;
}

async function callTelegram(method: string, body: unknown): Promise<SendResult> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_ALERT_CHAT_ID;
  if (!token || !chatId) return { ok: false, error: "telegram-not-configured", messageId: null };

  try {
    const res = await fetch(`${API_BASE}/bot${token}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, ...(body as object) }),
      cache: "no-store",
      // Telegram occasionally hangs. The webhook path must not hang with it.
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      return {
        ok: false,
        error: `telegram-${res.status}: ${detail.slice(0, 200)}`,
        messageId: null,
      };
    }
    const payload = (await res.json().catch(() => null)) as
      | { result?: { message_id?: number } }
      | null;
    return { ok: true, error: null, messageId: payload?.result?.message_id ?? null };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "telegram-failed",
      messageId: null,
    };
  }
}

/**
 * Post an alert. Never throws — see the note at the top of this file.
 *
 * `replyToMessageId` threads an escalation under the first message of its own
 * call, so 2 -> 3 -> 4 wallets on one token reads as one developing call rather
 * than three separate tips on the same coin.
 *
 * `allow_sending_without_reply` matters: the anchor can be deleted, and a reply
 * to a missing message is an error that would lose the whole alert over a
 * cosmetic detail.
 */
export async function sendAlertMessage(
  text: string,
  buttons: InlineButton[][],
  replyToMessageId?: number | null
): Promise<SendResult> {
  return callTelegram("sendMessage", {
    text,
    parse_mode: "HTML",
    // The alert is the message. A link preview card would push it off screen.
    link_preview_options: { is_disabled: true },
    reply_markup: { inline_keyboard: buttons },
    ...(replyToMessageId
      ? {
          reply_parameters: {
            message_id: replyToMessageId,
            allow_sending_without_reply: true,
          },
        }
      : {}),
  });
}

/** Plain text, for the raw verification mode and the heartbeat. */
export async function sendPlainMessage(text: string): Promise<SendResult> {
  return callTelegram("sendMessage", {
    text,
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
    disable_notification: true,
  });
}

/**
 * One line per classified trade, used only while `ALERTS_RAW_MODE` is on.
 *
 * This mode exists because buy classification is the one part of this system
 * that cannot be proven correct by reading it — Jupiter multi-hop, pump.fun
 * curves, Raydium, transfers and airdrops all have to land right, and a false
 * alert churns subscribers faster than no alerts at all. Raw mode puts every
 * classified trade in the channel so it can be checked against Solscan before
 * anyone trusts an aggregate built on top of it.
 */
export function buildRawLine(event: {
  wallet: string;
  label: string | null;
  side: string;
  mint: string;
  amountUsd: number;
  signature: string;
}): string {
  const who = event.label ? escapeHtml(event.label) : shorten(event.wallet);
  const arrow = event.side === "buy" ? "🟩 BUY " : "🟥 SELL";
  return (
    `${arrow} <b>${escapeHtml(who)}</b> ${formatUsd(event.amountUsd)}\n` +
    `<code>${escapeHtml(event.mint)}</code>\n` +
    `<a href="https://solscan.io/tx/${escapeHtml(event.signature)}">tx</a>`
  );
}

/**
 * The chat the bot posts to.
 *
 * Exposed because the pinned leaderboard stores it next to the message id: an
 * id is meaningless outside its chat, so a repointed `TELEGRAM_ALERT_CHAT_ID`
 * has to make the next sweep post a new message rather than edit an id that now
 * belongs to a different channel.
 */
export function telegramChatId(): string | null {
  return process.env.TELEGRAM_ALERT_CHAT_ID ?? null;
}

/** "42m ago", "6h ago", "yesterday". Coarse on purpose: a leaderboard row needs
 * the reader to know whether this is live or stale, not the exact minute. */
function humanAgo(iso: string, now: number): string {
  const seconds = Math.max(0, (now - new Date(iso).getTime()) / 1000);
  if (seconds < 90) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/** "+285%" for 3.85x. The multiple is the number traders think in and the
 * percentage is the one everyone else does, so both are on the row. */
function formatGainPercent(multiple: number): string {
  const pct = (multiple - 1) * 100;
  return `+${pct >= 100 ? Math.round(pct).toLocaleString("en-US") : pct.toFixed(0)}%`;
}

const RANK_MEDALS = ["🥇", "🥈", "🥉"];

export interface LeaderboardCall {
  tokenAddress: string;
  tokenSymbol: string | null;
  walletCount: number;
  entryMcapUsd: number;
  athMcapUsd: number;
  peakX: number;
  createdAt: string;
}

export interface LeaderboardInput {
  calls: LeaderboardCall[];
  chain: Chain;
  windowHours: number;
  /** Every call announced in the same window, not just the ones listed. */
  totalCalls: number;
  /** Passed in rather than read from the clock, so the message is a pure
   * function of its input and can be diffed in a test or a script. */
  now: number;
  /**
   * `pin` is the message that lives at the top of the channel and rewrites
   * itself hourly. `daily` is the once-a-day recap that notifies.
   *
   * Same rows, and deliberately the same builder — two copies of this would
   * drift, and the whole point is that the pin and the recap cannot disagree
   * about what a call did. Only the header and the footer differ, because the
   * two messages answer slightly different questions: the pin has to prove it
   * is still live, the recap has to say which day it is about.
   */
  variant?: "pin" | "daily";
  /** The recap's own day, already formatted in the owner's timezone. Passing it
   * in keeps this function free of a clock and of a timezone. */
  dayLabel?: string;
}

/**
 * The pinned message.
 *
 * A pin is the one message a stranger who opens the channel is guaranteed to
 * read, so it answers exactly one question: do these calls go anywhere. Each
 * row is the whole claim in two lines — the multiple, then the two market caps
 * it is the ratio of, so nobody has to take the multiple on trust.
 *
 * Two things it deliberately does NOT do:
 *
 *  - It does not show a hit rate or a median hold. Those live on /admin, and an
 *    operator's median read as a return somebody made is a claim we cannot
 *    stand behind.
 *  - It does not hide the denominator. "Top 3" with no count is a cherry-pick;
 *    "3 best of 112 calls" is the same three rows and an honest one.
 */
export function buildLeaderboardMessage(input: LeaderboardInput): string {
  const daily = input.variant === "daily";
  const out: string[] = [];
  out.push(
    daily
      ? `📅 <b>TODAY'S BEST CALLS</b>${input.dayLabel ? `  ·  ${escapeHtml(input.dayLabel)}` : ""}`
      : `🏆 <b>BEST CALLS · LAST ${Math.round(input.windowHours)}H</b>`
  );
  out.push("");

  if (input.calls.length === 0) {
    // An empty leaderboard is a real state — a quiet night, or a fresh deploy —
    // and saying so is better than leaving yesterday's winners pinned above
    // today's silence.
    out.push(
      daily
        ? "<i>Nothing traded above its entry in the last 24 hours. Some days are like that.</i>"
        : "<i>No call has traded above its entry yet in this window.</i>"
    );
    out.push("");
    out.push(`Every call lands in this channel the moment the wallets buy.`);
    out.push(`<a href="${brandUrl()}">AlphaWallets.fun</a>`);
    return out.join("\n");
  }

  input.calls.forEach((call, index) => {
    const rank = RANK_MEDALS[index] ?? `<b>${index + 1}.</b>`;
    const raw = escapeHtml((call.tokenSymbol || "?").replace(/^\$+/, ""));
    const symbol = `<a href="${dexScreenerUrl(input.chain, call.tokenAddress)}">${raw}</a>`;

    out.push(
      `${rank} <b>$${symbol}</b>  ·  <b>${formatMultiple(call.peakX)}</b>` +
        `  <b>${formatGainPercent(call.peakX)}</b>`
    );
    out.push(
      `<blockquote>called at ${formatUsd(call.entryMcapUsd)}  ·  peak ${formatUsd(call.athMcapUsd)}\n` +
        `${call.walletCount} smart wallets in  ·  ${humanAgo(call.createdAt, input.now)}</blockquote>`
    );
    // Telegram merges two blockquotes that touch into one block, which would
    // run three calls together into a single unreadable quote.
    out.push("");
  });

  // The denominator always ships with the list. "Top 3" on its own is a
  // cherry-pick; "3 best of 88 calls" is the same three rows and honest.
  //
  // The clock is on the pin only. The pin is edited in place, so a reader needs
  // a way to tell a live leaderboard from one that stopped updating three days
  // ago — a dated recap already says when it is from.
  const plural = input.totalCalls === 1 ? "" : "s";
  out.push(
    daily
      ? `<i>${input.calls.length} best of ${input.totalCalls} call${plural} in 24h</i>`
      : `<i>${input.calls.length} best of ${input.totalCalls} call${plural}` +
          ` · updated ${utcClock(input.now)} UTC</i>`
  );
  out.push(`<a href="${brandUrl()}">AlphaWallets.fun</a>`);

  return out.join("\n");
}

/** "14:05". The pin is edited in place, so a reader needs a way to tell a live
 * leaderboard from a message that stopped updating three days ago. */
function utcClock(now: number): string {
  return new Date(now).toISOString().slice(11, 16);
}

/**
 * Rewrite a message already in the channel.
 *
 * "message is not modified" is Telegram's answer when the new text is byte
 * identical to the old, which is a no-op rather than a failure — the pin is
 * already saying the right thing. Everything else is passed back so the caller
 * can decide whether the message is gone and a fresh one is needed.
 */
export async function editMessage(
  messageId: number,
  text: string,
  buttons?: InlineButton[][]
): Promise<SendResult> {
  const result = await callTelegram("editMessageText", {
    message_id: messageId,
    text,
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
    ...(buttons ? { reply_markup: { inline_keyboard: buttons } } : {}),
  });
  if (!result.ok && result.error?.includes("message is not modified")) {
    return { ok: true, error: null, messageId };
  }
  return result;
}

/**
 * Whether an edit failed because the message no longer exists.
 *
 * Telegram says this four different ways depending on whether the message was
 * deleted, was never in this chat, or was posted by somebody else. All four
 * mean the same thing to the caller: stop trying to edit it and post a new one.
 */
export function isMessageGone(error: string | null): boolean {
  if (!error) return false;
  const e = error.toLowerCase();
  return (
    e.includes("message to edit not found") ||
    e.includes("message can't be edited") ||
    e.includes("message_id_invalid") ||
    e.includes("message to pin not found")
  );
}

/**
 * Pin a message, silently.
 *
 * `disable_notification` matters: a pin normally notifies the whole channel,
 * and doing that once an hour would be a reason to mute the channel — which
 * would cost every real alert its notification too.
 */
export async function pinMessage(messageId: number): Promise<SendResult> {
  return callTelegram("pinChatMessage", {
    message_id: messageId,
    disable_notification: true,
  });
}

/**
 * The daily recap. The one message in this file that notifies.
 *
 * Everything else here is either an alert (which notifies by being an alert) or
 * a pin operation (silent, because an hourly pin notification is a reason to
 * mute the channel). The recap is once a day, and a recap nobody is pinged for
 * is a recap nobody reads.
 */
export async function sendDigestMessage(text: string): Promise<SendResult> {
  return callTelegram("sendMessage", {
    text,
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
  });
}

/** Post a message with no reply threading, for the pin. Separate from
 * `sendAlertMessage` only so the pin cannot accidentally inherit an alert's
 * reply parameters. */
export async function sendPinnedMessage(text: string): Promise<SendResult> {
  return callTelegram("sendMessage", {
    text,
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
    // The pin gets its own notification when it is pinned, and that one is
    // suppressed too. Two silent operations, one message in the channel.
    disable_notification: true,
  });
}
