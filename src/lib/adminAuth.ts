import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";

/**
 * Password gate for /admin. The password itself lives only in ADMIN_PASSWORD on
 * the server; the browser gets an HMAC-signed, expiring session cookie instead,
 * so the credential is never stored client-side and the cookie can't be forged.
 */
export const ADMIN_COOKIE = "aw_admin";
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

export function isAdminConfigured(): boolean {
  return Boolean(process.env.ADMIN_PASSWORD);
}

function secret(): string {
  // Distinct key material from the password so a leaked cookie signature can't
  // be worked backwards into the password itself.
  const password = process.env.ADMIN_PASSWORD ?? "";
  return `${process.env.OWNER_ACCESS_KEY ?? ""}|admin|${password}`;
}

function sign(payload: string): string {
  return createHmac("sha256", secret()).update(payload).digest("base64url");
}

function equals(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Constant-time so the password can't be recovered by timing the login route. */
export function checkPassword(candidate: string): boolean {
  const expected = process.env.ADMIN_PASSWORD;
  if (!expected || !candidate) return false;
  return equals(candidate, expected);
}

export function issueSession(): { value: string; maxAge: number } {
  const expiresAt = Date.now() + SESSION_TTL_MS;
  const payload = String(expiresAt);
  return {
    value: `${payload}.${sign(payload)}`,
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  };
}

export function verifySession(token: string | undefined): boolean {
  if (!token || !isAdminConfigured()) return false;
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return false;

  const payload = token.slice(0, dot);
  if (!equals(sign(payload), token.slice(dot + 1))) return false;
  return Number(payload) > Date.now();
}

export async function isAdminRequest(): Promise<boolean> {
  const store = await cookies();
  return verifySession(store.get(ADMIN_COOKIE)?.value);
}
