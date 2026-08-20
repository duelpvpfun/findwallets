"use client";

import type { TokenMeta, WalletHistory, WalletTrader } from "./types";

export interface CachedScan {
  token: TokenMeta;
  traders: WalletTrader[];
  isDemoData: boolean;
  histories?: Record<string, WalletHistory>;
  note?: string;
  scanSession?: string;
  isPreview?: boolean;
  previewLimit?: number;
  partial?: boolean;
  requestedCount?: number;
}

const KEY = "aw_last_scan";
/** Beyond this the prices and market caps in the result are stale enough to mislead. */
const MAX_AGE_MS = 6 * 60 * 60_000;

/**
 * Keeps the last result across reloads and tab discards. Without this a buyer
 * who refreshes loses a scan they already paid for, with the credit consumed.
 */
export function saveScan(scan: CachedScan): void {
  try {
    sessionStorage.setItem(KEY, JSON.stringify({ at: Date.now(), scan }));
  } catch {
    // Quota exceeded (a Top 500 result is large) or storage disabled — the
    // in-memory result still works for this page view.
  }
}

export function loadScan(): CachedScan | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { at: number; scan: CachedScan };
    if (!parsed?.scan?.token || Date.now() - parsed.at > MAX_AGE_MS) {
      sessionStorage.removeItem(KEY);
      return null;
    }
    return parsed.scan;
  } catch {
    return null;
  }
}

export function clearScan(): void {
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    // nothing to clear
  }
}
