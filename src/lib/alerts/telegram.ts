import "server-only";
import { SITE_URL } from "../siteUrl";
import { formatUsd } from "../format";
import { dexScreenerUrl, TRADE_LINKS, type AlertTier } from "./config";
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

/** Escalation reads at a glance in a busy channel. */
function tierEmoji(tier: AlertTier): string {
  if (tier.kind === "accumulation") return "🔴";
  if (tier.kind === "cluster") return "🟠";
  return "🟢";
}

export interface AlertMessageInput {
  tier: AlertTier;
  spanSeconds: number;
  tokenAddress: string;
  tokenSymbol: string | null;
  tokenName: string | null;
  mcapUsd: number | null;
  wallets: AlertWalletSnapshot[];
  avgMultipleX: number | null;
  avgPnlUsd: number | null;
  totalBoughtUsd: number;
  exitedCount: number;
}

/**
 * The message body.
 *
 * The second line is the entire reason this product is worth subscribing to:
 * `avg 5.75x · avg $50K PNL` comes from our own curated history of what these
 * wallets have already done, not from the trade that just happened. Anyone can
 * scrape a mempool and say "a wallet bought". Nobody else can say whose wallet.
 *
 * The elapsed time quoted is the REAL span between the first and last buy, not
 * the tier's configured window — "in the past 2 minutes" has to be true.
 */
export function buildAlertMessage(input: AlertMessageInput): string {
  const symbol = escapeHtml((input.tokenSymbol || "?").replace(/^\$+/, ""));
  const count = input.wallets.length;
  const lines: string[] = [];

  lines.push(
    `${tierEmoji(input.tier)} <b>${count} smart wallet${count === 1 ? "" : "s"} bought $${symbol}</b>` +
      ` in the past ${humanSpan(input.spanSeconds)}`
  );
  if (input.tokenName && input.tokenName !== input.tokenSymbol) {
    lines.push(`<i>${escapeHtml(input.tokenName)}</i>`);
  }
  lines.push("");

  const record: string[] = [];
  if (input.avgMultipleX !== null) record.push(`avg ${formatMultiple(input.avgMultipleX)}`);
  if (input.avgPnlUsd !== null) record.push(`avg ${formatUsd(input.avgPnlUsd)} PNL`);
  if (record.length > 0) lines.push(`📈 Track record   ${record.join("  ·  ")}`);
  if (input.mcapUsd && input.mcapUsd > 0) {
    lines.push(`💰 Market cap     ${formatUsd(input.mcapUsd)}`);
  }
  lines.push(`💵 Bought now     ${formatUsd(input.totalBoughtUsd)}`);
  if (input.exitedCount > 0) {
    // Counted toward the tier regardless — but a reader chasing an entry that
    // one of these wallets has already sold deserves to know before they buy.
    lines.push(
      `⚠️ ${input.exitedCount} of ${count} already sold some back`
    );
  }
  lines.push("");

  for (const wallet of input.wallets) {
    const name = wallet.label ? escapeHtml(wallet.label) : `<code>${shorten(wallet.address)}</code>`;
    const parts = [formatMultiple(wallet.multipleX)];
    if (wallet.pnlUsd !== null) parts.push(formatUsd(wallet.pnlUsd));
    const suffix = wallet.exited ? "  ↩ sold" : "";
    lines.push(
      `• ${name} — ${parts.join(" · ")} avg · ${formatUsd(wallet.boughtUsd)} in${suffix}`
    );
  }

  lines.push("");
  lines.push(`<code>${escapeHtml(input.tokenAddress)}</code>`);

  return lines.join("\n");
}

interface InlineButton {
  text: string;
  url: string;
}

/**
 * The referral row. Every alert is a revenue opportunity rather than a cost
 * centre, which is what lets the channel stay free.
 *
 * A missing referral code falls back to the plain link: an unset env var should
 * cost commission, never break the message.
 */
export function buildAlertButtons(tokenAddress: string): InlineButton[][] {
  const trade = TRADE_LINKS.map((link) => {
    const ref = process.env[link.refEnv];
    return { text: link.name, url: ref ? link.withRef(tokenAddress, ref) : link.plain(tokenAddress) };
  });

  return [
    trade.slice(0, 2),
    trade.slice(2, 4),
    [
      { text: "📊 Chart", url: dexScreenerUrl(tokenAddress) },
      { text: "🔎 Full feed", url: new URL("/alerts", SITE_URL).toString() },
    ],
  ].filter((row) => row.length > 0);
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
