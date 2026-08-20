import { NextRequest, NextResponse } from "next/server";
import { findCreditByPaymentId } from "@/lib/db/credits";
import { clientIp, rateLimit } from "@/lib/rateLimit";

export const dynamic = "force-dynamic";

// The signature is public on-chain, so this endpoint is the one place a
// guessable identifier maps to a claim token. Kept tight to make enumeration
// pointless, and only ever returns tokens that are still unspent.
const MAX_REQUESTS_PER_MINUTE = 10;

/** Base58, 64 bytes — Solana transaction signatures are 87-88 characters. */
const SIGNATURE_RE = /^[1-9A-HJ-NP-Za-km-z]{80,90}$/;

export async function GET(request: NextRequest) {
  const limited = await rateLimit(`recover:${clientIp(request)}`, MAX_REQUESTS_PER_MINUTE, 60_000);
  if (!limited.ok) {
    return NextResponse.json(
      { error: "Too many attempts. Wait a minute and try again." },
      { status: 429, headers: { "Retry-After": String(limited.retryAfterSeconds) } }
    );
  }

  const signature = request.nextUrl.searchParams.get("signature")?.trim() ?? "";
  if (!SIGNATURE_RE.test(signature)) {
    return NextResponse.json(
      { error: "That doesn't look like a Solana transaction signature." },
      { status: 400 }
    );
  }

  const credit = await findCreditByPaymentId(signature);
  if (!credit) {
    return NextResponse.json(
      {
        found: false,
        error:
          "No purchase found for that signature. Payments can take a minute to confirm — try again shortly.",
      },
      { status: 404 }
    );
  }

  if (credit.consumed) {
    return NextResponse.json({
      found: true,
      consumed: true,
      tier: credit.tier,
      error: "This purchase has already been used for a scan.",
    });
  }

  return NextResponse.json({
    found: true,
    consumed: false,
    tier: credit.tier,
    claimToken: credit.claimToken,
  });
}
