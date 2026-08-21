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
  return new URL("/alerts", SITE_URL).toString();
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
 *   3. **Who these wallets are.** This is the entire moat. `avg 5.8x ·
 *      $50.2K per win` comes from our own curated history of what these
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

  const record: string[] = [];
  if (input.avgMultipleX !== null) record.push(`avg <b>${formatMultiple(input.avgMultipleX)}</b>`);
  if (input.avgPnlUsd !== null) record.push(`<b>${formatUsd(input.avgPnlUsd)}</b> per win`);
  if (record.length > 0) out.push(`🏆 <b>Their record:</b> ${record.join(" · ")}`);

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
    const ref = process.env[link.refEnv];
    return {
      text: link.name,
      url: ref ? link.withRef(chain, tokenAddress, ref) : link.plain(chain, tokenAddress),
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
    { text: "🔎 AlphaWallets.fun", url: brandUrl() },
  ]);
  return rows;
}

export interface SendResult {
  ok: boolean;
  error: string | null;
}

async function callTelegram(method: string, body: unknown): Promise<SendResult> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_ALERT_CHAT_ID;
  if (!token || !chatId) return { ok: false, error: "telegram-not-configured" };

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
      return { ok: false, error: `telegram-${res.status}: ${detail.slice(0, 200)}` };
    }
    return { ok: true, error: null };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "telegram-failed" };
  }
}

/** Post an alert. Never throws — see the note at the top of this file. */
export async function sendAlertMessage(
  text: string,
  buttons: InlineButton[][]
): Promise<SendResult> {
  return callTelegram("sendMessage", {
    text,
    parse_mode: "HTML",
    // The alert is the message. A link preview card would push it off screen.
    link_preview_options: { is_disabled: true },
    reply_markup: { inline_keyboard: buttons },
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
