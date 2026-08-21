import "server-only";
import { timingSafeEqual } from "node:crypto";
import { reserveCredit, reserveUserCredit, type Tier } from "./db/credits";
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

/**
 * Where the entitlement came from. The client needs this: when an account credit
 * is spent, a claim token still sitting in the browser is UNSPENT, and clearing
 * localStorage on the assumption it was used would destroy a paid purchase.
 */
export type AccessSource = "owner" | "payments_disabled" | "account" | "claim_token";

export interface AccessResult {
  allowed: boolean;
  /** Highest wallet count this request may receive. */
  maxLimit: number;
  isOwner: boolean;
  /** Present only when a paid credit should be consumed after a successful scan.
   * For an account credit this is the reserved credit's own token, not anything
   * the caller supplied — it exists so settle/release can use one code path. */
  claimToken?: string;
  /** Set when the credit came from a signed-in account rather than a claim token. */
  userId?: number;
  source?: AccessSource;
  reason?: AccessDenyReason;
}

export interface AccessRequest {
  ownerKey: string | null;
  claimToken: string | null;
  /** The signed-in user, if any. Never required — anonymous buyers are first-class. */
  userId: number | null;
  chain: Chain;
  tokenAddress: string;
  /** Wallets the caller is asking for, used to pick a credit big enough. */
  requestedLimit: number;
}

/**
 * Decides how many wallets a request is entitled to. Gating lives here, on the
 * server, because anything enforced in the browser can be bypassed via devtools.
 * When PAYMENTS_ENABLED is not "true" the app stays fully open (current behavior).
 *
 * Precedence: owner key -> signed-in balance -> claim token -> payment required.
 *
 * The account balance is tried before the claim token so a buyer who signs in
 * spends the credits they can see on their profile first, rather than silently
 * burning a token still sitting in localStorage. If the balance has nothing big
 * enough, the claim-token path runs exactly as it always has — signing in never
 * takes a redemption route away from anybody.
 *
 * A paid credit is claimed here, before the scan runs, so two concurrent
 * requests can never both be authorized off the same purchase. The caller must
 * release it if the scan ends up delivering nothing.
 */
export async function resolveAccess(request: AccessRequest): Promise<AccessResult> {
  const { ownerKey, claimToken, userId, chain, tokenAddress, requestedLimit } = request;

  if (isOwnerKey(ownerKey)) {
    return { allowed: true, maxLimit: Number.MAX_SAFE_INTEGER, isOwner: true, source: "owner" };
  }

  // Deliberately open when unset (pre-launch behaviour), but a deploy that drops
  // the var in production would hand the product away, so that case is loud.
  if (process.env.PAYMENTS_ENABLED !== "true") {
    if (process.env.VERCEL_ENV === "production" && process.env.PAYMENTS_ENABLED === undefined) {
      console.error("[access] PAYMENTS_ENABLED is unset in production — scans are FREE.");
    }
    return {
      allowed: true,
      maxLimit: Number.MAX_SAFE_INTEGER,
      isOwner: false,
      source: "payments_disabled",
    };
  }

  if (userId !== null) {
    const fromBalance = await reserveUserCredit(userId, requestedLimit, chain, tokenAddress);
    if (fromBalance.valid && fromBalance.claimToken) {
      return {
        allowed: true,
        maxLimit: fromBalance.tier as Tier,
        isOwner: false,
        claimToken: fromBalance.claimToken,
        userId,
        source: "account",
      };
    }
    // A reservation this young belongs to a scan of theirs that is genuinely
    // still running. Saying "buy another" there would be a lie, so it short
    // -circuits rather than falling through to the paywall.
    if (fromBalance.reason === "reservation_pending") {
      return { allowed: false, maxLimit: 0, isOwner: false, reason: "credit_pending" };
    }
    // Otherwise: no credit big enough on the account. Fall through — they may
    // still be holding a claim token from before they signed in.
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
    userId: userId ?? undefined,
    source: "claim_token",
  };
}
