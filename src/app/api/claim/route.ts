import { NextRequest, NextResponse } from "next/server";
import {
  bindNonceToPayment,
  checkCredit,
  hashNonce,
  releaseClaim,
  releaseClaimByNonce,
} from "@/lib/db/credits";
import { clientIp, rateLimit } from "@/lib/rateLimit";

/**
 * After Helio's widget reports success the browser polls here with the payment
 * id, because the server-to-server webhook can land a moment later.
 *
 * The payment id is a public on-chain signature, so it is never sufficient on
 * its own — the caller must also present the nonce it generated before paying.
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

  const paymentId = request.nextUrl.searchParams.get("paymentId")?.trim();
  const claim = request.nextUrl.searchParams.get("claim")?.trim();
  const nonce = request.nextUrl.searchParams.get("nonce")?.trim();

  // Lets the UI show remaining entitlement for a token it already holds.
  if (claim) {
    const status = await checkCredit(claim);
    return NextResponse.json(status);
  }

  if (!nonce) {
    return NextResponse.json({ error: "Missing nonce" }, { status: 400 });
  }

  // The nonce is the reliable join: Helio's payload field carrying the payment
  // id varies, so matching on it alone left paid credits stranded as "pending".
  let result = await releaseClaimByNonce(nonce);

  if (result.status !== "ok" && paymentId) {
    const byPayment = await releaseClaim(paymentId, nonce);
    // Helio may not echo our nonce back, leaving the credit unbound; adopt it for
    // the first caller inside the short post-checkout window, then re-resolve.
    if (byPayment.status === "forbidden" && (await bindNonceToPayment(paymentId, hashNonce(nonce)))) {
      result = await releaseClaim(paymentId, nonce);
    } else if (byPayment.status !== "pending") {
      result = byPayment;
    }
  }

  switch (result.status) {
    case "ok":
      return NextResponse.json({ claimToken: result.claimToken, tier: result.tier });
    case "pending":
      return NextResponse.json({ pending: true }, { status: 202 });
    case "no_db":
      return NextResponse.json({ error: "Database not configured" }, { status: 503 });
    default:
      return NextResponse.json({ error: "Claim not available." }, { status: 403 });
  }
}
