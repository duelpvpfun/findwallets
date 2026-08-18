import type { ExportGroup, WalletTrader } from "./types";
import { formatMultiple, formatUsd, shortenAddress, tokenNameForExport } from "./format";

const EMOJIS = ["🧓", "👻", "🐍", "🦅", "🧙", "🐉", "🥷", "🦈", "🐺", "🦊", "🐯", "🦁"];

function emojiForAddress(address: string): string {
  let hash = 0;
  for (let i = 0; i < address.length; i++) hash = (hash * 31 + address.charCodeAt(i)) >>> 0;
  return EMOJIS[hash % EMOJIS.length];
}

export type NameStyle = "multiple" | "pnl" | "rank" | "address";

export interface ExportOptions {
  /** "" means keep the auto-assigned per-wallet emoji. */
  emoji: string;
  alertsOnToast: boolean;
  alertsOnBubble: boolean;
  alertsOnFeed: boolean;
  group: string;
  sound: string;
  nameStyle: NameStyle;
  /** Prepended to every generated name, e.g. "alpha " -> "alpha 25.00x - TRUMP". */
  namePrefix: string;
  /** Use the wallet's known nickname/KOL name when one exists. */
  preferNickname: boolean;
  filename: string;
}

export const DEFAULT_EXPORT_OPTIONS: ExportOptions = {
  emoji: "",
  alertsOnToast: false,
  alertsOnBubble: true,
  alertsOnFeed: true,
  group: "Main",
  sound: "default",
  nameStyle: "multiple",
  namePrefix: "",
  preferNickname: true,
  filename: "",
};

function buildName(
  trader: WalletTrader,
  tokenSymbol: string,
  opts: ExportOptions
): string {
  if (opts.preferNickname && trader.nickname) return `${opts.namePrefix}${trader.nickname}`;
  const base =
    opts.nameStyle === "pnl"
      ? `${formatUsd(trader.realizedPnlUsd)} - ${tokenSymbol}`
      : opts.nameStyle === "rank"
      ? `#${trader.rank} - ${tokenSymbol}`
      : opts.nameStyle === "address"
      ? shortenAddress(trader.address)
      : trader.avgMultipleX === null
      ? // No measurable multiple, so name it by the figure that is real.
        `${formatUsd(trader.realizedPnlUsd)} - ${tokenSymbol}`
      : `${formatMultiple(trader.avgMultipleX)} - ${tokenSymbol}`;
  return `${opts.namePrefix}${base}`;
}

export function buildExportEntries(
  tokenSymbol: string,
  traders: WalletTrader[],
  options: ExportOptions = DEFAULT_EXPORT_OPTIONS
): ExportGroup[] {
  return traders.map((t) => ({
    trackedWalletAddress: t.address,
    name: buildName(t, tokenSymbol, options),
    emoji: options.emoji || emojiForAddress(t.address),
    alertsOnToast: options.alertsOnToast,
    alertsOnBubble: options.alertsOnBubble,
    alertsOnFeed: options.alertsOnFeed,
    groups: [options.group || "Main"],
    sound: options.sound || "default",
  }));
}

/** The exact bytes `exportTraders` would download, for pasting straight into a bot. */
export function buildExportJson(
  tokenSymbol: string,
  traders: WalletTrader[],
  options: ExportOptions = DEFAULT_EXPORT_OPTIONS
): string {
  return JSON.stringify(buildExportEntries(tokenSymbol, traders, options), null, 2);
}

/** Falls back to a hidden textarea because clipboard.writeText needs a secure
 * context, which excludes plain-http and some in-app browsers. */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall through to the legacy path.
  }
  try {
    const el = document.createElement("textarea");
    el.value = text;
    el.setAttribute("readonly", "");
    el.style.position = "fixed";
    el.style.opacity = "0";
    document.body.appendChild(el);
    el.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(el);
    return ok;
  } catch {
    return false;
  }
}

export function downloadJson(filename: string, data: unknown) {
  const blob = new Blob([JSON.stringify(data, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename.endsWith(".json") ? filename : `${filename}.json`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

export function exportTraders(
  tokenName: string,
  tokenSymbol: string,
  traders: WalletTrader[],
  options: ExportOptions = DEFAULT_EXPORT_OPTIONS
) {
  const entries = buildExportEntries(tokenSymbol, traders, options);
  const filename = options.filename.trim() || tokenNameForExport(tokenName);
  downloadJson(filename, entries);
}
