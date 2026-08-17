import { NextRequest, NextResponse } from "next/server";
import { checkCredit } from "@/lib/db/credits";
import { clientIp, rateLimit } from "@/lib/rateLimit";

/**
 * Lets the UI check remaining entitlement for a claim token it already holds
 * (e.g. after a page refresh mid-session). Purchase confirmation itself now
 * happens in /api/pay/confirm, verified directly against Solana.
 */
const MAX_REQUESTS_PER_MINUTE = 60;

export async function GET(request: NextRequest) {
  const limited = rateLimit(`claim:${clientIp(request)}`, MAX_REQUESTS_PER_MINUTE, 60_000);
  if (!limited.ok) {
    return NextResponse.json(
      { error: "Too many requests. Slow down." },
      { status: 429, headers: { "Retry-After": String(limited.retryAfterSeconds) } }
    );
  }

  const claim = request.nextUrl.searchParams.get("claim")?.trim();
  if (!claim) {
    return NextResponse.json({ error: "Missing claim token" }, { status: 400 });
  }

  const status = await checkCredit(claim);
  return NextResponse.json(status);
}

