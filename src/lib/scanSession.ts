import "server-only";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { Chain } from "./types";

/**
 * Proof that the bearer already completed an authorized scan of a specific
 * token. Issued by /api/top-traders and required by /api/wallet-detail, so the
 * per-wallet drill-down can't be called by anyone who never paid.
 *
 * Stateless by design: it is scoped to one token and expires, so there is
 * nothing worth persisting and no extra database round-trip on every click.
 */
const TTL_MS = 6 * 60 * 60 * 1000;

function secret(): string {
  const explicit = process.env.SCAN_SESSION_SECRET;
  if (explicit) return explicit;

  // Falls back to a value that already exists in every deployment so a missing
  // extra env var can never silently disable signing. Derived rather than used
  // raw, so the owner credential itself is never the HMAC key.
  const owner = process.env.OWNER_ACCESS_KEY;
  if (!owner) throw new Error("No signing secret configured for scan sessions.");
  return createHash("sha256").update(`scan-session:${owner}`).digest("hex");
}

export interface ScanSession {
  chain: Chain;
  tokenAddress: string;
  expiresAt: number;
}

function sign(payload: string): string {
  return createHmac("sha256", secret()).update(payload).digest("base64url");
}

export function issueScanSession(chain: Chain, tokenAddress: string): string {
  const payload = `${chain}.${tokenAddress.toLowerCase()}.${Date.now() + TTL_MS}`;
  return `${Buffer.from(payload).toString("base64url")}.${sign(payload)}`;
}

export function verifyScanSession(
  token: string | null,
  chain: Chain,
  tokenAddress: string
): boolean {
  if (!token) return false;

  const separator = token.lastIndexOf(".");
  if (separator <= 0) return false;

  const encodedPayload = token.slice(0, separator);
  const providedSignature = token.slice(separator + 1);

  let payload: string;
  try {
    payload = Buffer.from(encodedPayload, "base64url").toString("utf8");
  } catch {
    return false;
  }

  const expected = Buffer.from(sign(payload));
  const provided = Buffer.from(providedSignature);
  if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) return false;

  const [signedChain, signedToken, signedExpiry] = payload.split(".");
  if (signedChain !== chain) return false;
  if (signedToken !== tokenAddress.toLowerCase()) return false;
  return Number(signedExpiry) > Date.now();
}
