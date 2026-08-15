import type { ExportGroup, WalletTrader } from "./types";
import { formatMultiple, tokenNameForExport } from "./format";

const EMOJIS = ["🧓", "👻", "🐍", "🦅", "🧙", "🐉", "🥷", "🦈", "🐺", "🦊", "🐯", "🦁"];

function emojiForAddress(address: string): string {
  let hash = 0;
  for (let i = 0; i < address.length; i++) hash = (hash * 31 + address.charCodeAt(i)) >>> 0;
  return EMOJIS[hash % EMOJIS.length];
}

export function buildExportEntries(tokenSymbol: string, traders: WalletTrader[]): ExportGroup[] {
  return traders.map((t) => ({
    trackedWalletAddress: t.address,
    name: t.nickname ?? `${formatMultiple(t.avgMultipleX)} - ${tokenSymbol}`,
    emoji: emojiForAddress(t.address),
    alertsOnToast: false,
    alertsOnBubble: true,
    alertsOnFeed: true,
    groups: ["Main"],
    sound: "default",
  }));
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

export function exportTraders(tokenName: string, tokenSymbol: string, traders: WalletTrader[]) {
  const entries = buildExportEntries(tokenSymbol, traders);
  const filename = tokenNameForExport(tokenName);
  downloadJson(filename, entries);
}
