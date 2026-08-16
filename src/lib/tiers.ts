/** Client-safe tier metadata. Prices are display-only — the real entitlement
 * comes from the paylink the user actually paid, resolved server-side. */
export interface TierInfo {
  limit: number;
  paylinkId: string;
  price: string;
  label: string;
}

export const TIER_OPTIONS: TierInfo[] = [
  { limit: 100, paylinkId: "6a821074f6597f12ce9f98c4", price: "$2.99", label: "Top 100" },
  { limit: 250, paylinkId: "6a8214f8a9d7742eda4f78b5", price: "$4.45", label: "Top 250" },
  { limit: 500, paylinkId: "6a82154181e40c11230808b0", price: "$5.99", label: "Top 500" },
];

export const CLAIM_STORAGE_KEY = "findwallets.claim";

/** Owner key is pasted once via `?key=…`, then kept locally so every later
 * scan is free. It is only ever validated server-side. */
export const OWNER_STORAGE_KEY = "findwallets.owner";
