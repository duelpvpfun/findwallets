/** Client-safe tier metadata. `priceUsd` is what the server actually quotes in
 * SOL/USDC at payment time — the display `price` string must stay in sync. */
export interface TierInfo {
  limit: number;
  priceUsd: number;
  price: string;
  label: string;
}

export const TIER_OPTIONS: TierInfo[] = [
  { limit: 100, priceUsd: 2.99, price: "$2.99", label: "Top 100" },
  { limit: 250, priceUsd: 4.45, price: "$4.45", label: "Top 250" },
  { limit: 500, priceUsd: 5.99, price: "$5.99", label: "Top 500" },
];

export const CLAIM_STORAGE_KEY = "findwallets.claim";

/** Owner key is pasted once via `?key=…`, then kept locally so every later
 * scan is free. It is only ever validated server-side. */
export const OWNER_STORAGE_KEY = "findwallets.owner";

/** Set when a visitor ticks "don't show again" on the welcome export preview. */
export const PREVIEW_DISMISSED_KEY = "findwallets.previewDismissed";
