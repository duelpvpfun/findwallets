import "server-only";
import { timingSafeEqual } from "node:crypto";
import { reserveCredit, type Tier } from "./db/credits";
import type { Chain } from "./types";

/** Free unlimited access for the owner. Compared in constant time so the key
 * can't be recovered by timing the endpoint. */
export function isOwnerKey(key: string | null): boolean {
  const expected = process.env.OWNER_ACCESS_KEY;
  if (!expected || !key) return false;
  const a = Buffer.from(key);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export type AccessDenyReason =
  | "payment_required"
  | "credit_used"
  | "credit_pending"
  | "credit_invalid";

export interface AccessResult {
  allowed: boolean;
  /** Highest wallet count this request may receive. */
  maxLimit: number;
  isOwner: boolean;
  /** Present only when a paid credit should be consumed after a successful scan. */
  claimToken?: string;
  reason?: AccessDenyReason;
}

/**
 * Decides how many wallets a request is entitled to. Gating lives here, on the
 * server, because anything enforced in the browser can be bypassed via devtools.
 * When PAYMENTS_ENABLED is not "true" the app stays fully open (current behavior).
 *
 * A paid credit is claimed here, before the scan runs, so two concurrent
 * requests can never both be authorized off the same purchase. The caller must
 * release it if the scan ends up delivering nothing.
 */
export async function resolveAccess(
  ownerKey: string | null,
  claimToken: string | null,
  chain: Chain,
  tokenAddress: string
): Promise<AccessResult> {
  if (isOwnerKey(ownerKey)) {
    return { allowed: true, maxLimit: Number.MAX_SAFE_INTEGER, isOwner: true };
  }

  // Deliberately open when unset (pre-launch behaviour), but a deploy that drops
  // the var in production would hand the product away, so that case is loud.
  if (process.env.PAYMENTS_ENABLED !== "true") {
    if (process.env.VERCEL_ENV === "production" && process.env.PAYMENTS_ENABLED === undefined) {
      console.error("[access] PAYMENTS_ENABLED is unset in production — scans are FREE.");
    }
    return { allowed: true, maxLimit: Number.MAX_SAFE_INTEGER, isOwner: false };
  }

  if (!claimToken) {
    return { allowed: false, maxLimit: 0, isOwner: false, reason: "payment_required" };
  }

  const status = await reserveCredit(claimToken, chain, tokenAddress);
  if (!status.valid) {
    return {
      allowed: false,
      maxLimit: 0,
      isOwner: false,
      reason:
        status.reason === "already_used"
          ? "credit_used"
          : // A reservation this young belongs to a scan that is genuinely still
            // running: reserveCredit hands the token back to its owner once the
            // reservation is stale, so reaching here means "wait", not "spent".
            status.reason === "reservation_pending"
            ? "credit_pending"
            : "credit_invalid",
    };
  }

  return {
    allowed: true,
    maxLimit: status.tier as Tier,
    isOwner: false,
    claimToken,
  };
}
