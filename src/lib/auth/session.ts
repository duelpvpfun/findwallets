import "server-only";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";

/**
 * The signed-in session, as an HMAC-signed expiring cookie.
 *
 * Same pattern as `src/lib/adminAuth.ts` and the same derive-don't-reuse
 * discipline as `src/lib/scanSession.ts`: nothing is stored server-side, so
 * there is no session table to sweep and no extra round-trip per request. What
 * the cookie carries — a user id and a wallet address — is not secret; the
 * signature is what makes it unforgeable.
 *
 * NextAuth would bring a dependency, a database adapter and a second auth model
 * into a codebase that already has two working HMAC-cookie implementations.
 */
export const AUTH_COOKIE = "aw_user";

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Re-issue the cookie once it is inside this window of expiring, so an active
 * user's 30 days keeps sliding forward without writing a fresh Set-Cookie on
 * every single request.
 */
const REFRESH_WHEN_REMAINING_MS = 25 * 24 * 60 * 60 * 1000;

function secret(): string {
  const explicit = process.env.AUTH_SESSION_SECRET;
  if (explicit) return explicit;

  // Falls back to a value every deployment already has, so a missing env var
  // can never silently disable signing. Derived, not used raw, so the owner
  // credential itself is never the HMAC key.
  const owner = process.env.OWNER_ACCESS_KEY;
  if (!owner) throw new Error("No signing secret configured for user sessions.");
  return createHash("sha256").update(`auth-session:${owner}`).digest("hex");
}

function sign(payload: string): string {
  return createHmac("sha256", secret()).update(payload).digest("base64url");
}

function equals(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export interface SessionUser {
  id: number;
  wallet: string;
  expiresAt: number;
}

export interface IssuedSession {
  name: string;
  value: string;
  maxAge: number;
}

/** Cookie attributes, in one place so no route can accidentally drop `httpOnly`. */
export function sessionCookieOptions(maxAge: number) {
  return {
    httpOnly: true,
    // Only ever false on plain-HTTP localhost; Vercel is always HTTPS.
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
    maxAge,
  };
}

export function issueSession(user: { id: number; wallet: string }): IssuedSession {
  const expiresAt = Date.now() + SESSION_TTL_MS;
  // `.` separates the fields, so neither may contain one. A base58 wallet
  // cannot, and the id is a number — but the payload is base64url-encoded as a
  // whole anyway, which keeps the separator unambiguous.
  const payload = Buffer.from(`${user.id}.${user.wallet}.${expiresAt}`).toString("base64url");
  return {
    name: AUTH_COOKIE,
    value: `${payload}.${sign(payload)}`,
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  };
}

export function verifySessionToken(token: string | undefined): SessionUser | null {
  if (!token) return null;

  const separator = token.lastIndexOf(".");
  if (separator <= 0) return null;

  const payload = token.slice(0, separator);
  if (!equals(sign(payload), token.slice(separator + 1))) return null;

  let decoded: string;
  try {
    decoded = Buffer.from(payload, "base64url").toString("utf8");
  } catch {
    return null;
  }

  const [rawId, wallet, rawExpiry] = decoded.split(".");
  const id = Number(rawId);
  const expiresAt = Number(rawExpiry);
  if (!Number.isInteger(id) || id <= 0 || !wallet) return null;
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) return null;

  return { id, wallet, expiresAt };
}

/**
 * The signed-in user for this request, or null. Signature-checked only — no
 * database read — so it is safe to call from anywhere, including the paid scan
 * path where an extra query costs the buyer latency.
 *
 * A deleted user would keep a valid cookie until it expires. Accounts are never
 * deleted here, and the worst it grants is a lookup of a balance that is empty.
 */
export async function getSessionUser(): Promise<SessionUser | null> {
  try {
    const store = await cookies();
    return verifySessionToken(store.get(AUTH_COOKIE)?.value);
  } catch {
    // No signing secret configured, or called outside a request scope. Treated
    // as "not signed in" rather than breaking the page.
    return null;
  }
}

/** True when this session is close enough to expiry to be worth re-issuing. */
export function shouldRefresh(session: SessionUser): boolean {
  return session.expiresAt - Date.now() < REFRESH_WHEN_REMAINING_MS;
}
