import { NextResponse } from "next/server";
import {
  AUTH_COOKIE,
  getSessionUser,
  issueSession,
  sessionCookieOptions,
  shouldRefresh,
} from "@/lib/auth/session";
import { fetchCreditBalance } from "@/lib/db/credits";

export const dynamic = "force-dynamic";

/**
 * Who is signed in, and what they can spend.
 *
 * The session cookie is `httpOnly`, so the browser cannot read it — this is how
 * the client learns who it is, which is the same thing as reading the session
 * server-side. One indexed query per page load.
 *
 * Also where the sliding 30-day window slides: an active user's cookie is
 * re-issued once it is inside five days of expiring, so someone who visits
 * weekly never gets logged out, while an abandoned session still dies.
 */
export async function GET() {
  const session = await getSessionUser();
  if (!session) {
    return NextResponse.json(
      { user: null, balance: null },
      { headers: { "Cache-Control": "no-store" } }
    );
  }

  // Sequential by necessity, not by habit: a Promise.all of database calls here
  // is a latent hang against Supabase's transaction pooler (see AGENTS.md).
  const balance = await fetchCreditBalance(session.id);

  const response = NextResponse.json(
    {
      user: { wallet: session.wallet },
      balance,
    },
    { headers: { "Cache-Control": "no-store" } }
  );

  if (shouldRefresh(session)) {
    const refreshed = issueSession({ id: session.id, wallet: session.wallet });
    response.cookies.set(AUTH_COOKIE, refreshed.value, sessionCookieOptions(refreshed.maxAge));
  }

  return response;
}
