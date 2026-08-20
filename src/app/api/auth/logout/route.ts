import { NextResponse } from "next/server";
import { AUTH_COOKIE, sessionCookieOptions } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

/**
 * Ends the session by expiring the cookie.
 *
 * Nothing server-side to revoke — the session is a signed, self-expiring token
 * rather than a database row. POST rather than GET so a link or a prefetch can't
 * sign someone out.
 */
export async function POST() {
  const response = NextResponse.json({ ok: true });
  response.cookies.set(AUTH_COOKIE, "", sessionCookieOptions(0));
  return response;
}
