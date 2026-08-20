import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth/session";
import { absorbClaimToken } from "@/lib/db/users";
import { clientIp, rateLimit } from "@/lib/rateLimit";

export const dynamic = "force-dynamic";

/**
 * Moves a browser-held claim token onto the signed-in account.
 *
 * Called once on load when a session and a stored claim token coexist. The
 * client clears its localStorage only after this confirms, so a failed request
 * can never lose the buyer their only handle on a purchase.
 *
 * Not an escalation: whoever holds a claim token can already redeem it, so
 * attaching it grants nothing new. `absorbClaimToken` scopes the update to
 * credits that are unspent and unattached.
 */
const MAX_REQUESTS_PER_MINUTE = 20;

export async function POST(request: NextRequest) {
  const limited = await rateLimit(`auth-absorb:${clientIp(request)}`, MAX_REQUESTS_PER_MINUTE, 60_000);
  if (!limited.ok) {
    return NextResponse.json(
      { error: "Too many requests." },
      { status: 429, headers: { "Retry-After": String(limited.retryAfterSeconds) } }
    );
  }

  const session = await getSessionUser();
  if (!session) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const claimToken = typeof body.claimToken === "string" ? body.claimToken.trim() : "";
  if (!claimToken) return NextResponse.json({ error: "Missing claim token." }, { status: 400 });

  try {
    const outcome = await absorbClaimToken(session.id, claimToken);
    // "spent" and "unknown" both mean the browser copy is worthless, so it is
    // safe for the client to forget it. "absorbed"/"already_mine" mean the
    // account holds it now, which is also safe to forget.
    return NextResponse.json({ outcome, safeToForget: outcome !== "no_db" });
  } catch (err) {
    console.error("[auth/absorb] failed:", err);
    return NextResponse.json({ error: "Could not attach that purchase." }, { status: 500 });
  }
}
