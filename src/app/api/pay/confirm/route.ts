import { NextRequest, NextResponse } from "next/server";
import { getIntentForNonce, consumePaymentIntent, isIntentExpired } from "@/lib/db/paymentIntents";
import { createCredits, logWebhook } from "@/lib/db/credits";
import { verifyPaymentTransaction } from "@/lib/solanaPay";
import { clientIp, rateLimit } from "@/lib/rateLimit";

/**
 * Confirms a payment directly against Solana via Helius — never trusting the
 * browser's word that a transaction succeeded. The browser polls this after
 * sending the transaction, same shape as the old Helio-webhook wait, except
 * now the verification happens synchronously against chain data we fetch
 * ourselves instead of waiting on a third party to call us back.
 */
const MAX_REQUESTS_PER_MINUTE = 60;

export async function GET(request: NextRequest) {
  const limited = await rateLimit(
    `pay-confirm:${clientIp(request)}`,
    MAX_REQUESTS_PER_MINUTE,
    60_000
  );
  if (!limited.ok) {
    return NextResponse.json(
      { error: "Too many requests. Slow down." },
      { status: 429, headers: { "Retry-After": String(limited.retryAfterSeconds) } }
    );
  }

  const intentId = request.nextUrl.searchParams.get("intentId")?.trim();
  const nonce = request.nextUrl.searchParams.get("nonce")?.trim();
  const signature = request.nextUrl.searchParams.get("signature")?.trim();

  if (!intentId || !nonce || !signature) {
    return NextResponse.json({ error: "Missing intentId, nonce or signature." }, { status: 400 });
  }

  const intent = await getIntentForNonce(intentId, nonce);
  if (!intent) {
    return NextResponse.json({ error: "Unknown purchase." }, { status: 403 });
  }

  if (intent.status === "consumed") {
    // Replay-safe: a second poll for an already-confirmed intent just gets
    // back the same claim token instead of re-verifying against Helius.
    if (intent.claimToken) {
      return NextResponse.json({ claimToken: intent.claimToken, tier: intent.tier });
    }
    return NextResponse.json({ error: "This purchase was already used." }, { status: 403 });
  }

  if (isIntentExpired(intent)) {
    return NextResponse.json({ error: "This quote expired. Start the payment again." }, { status: 410 });
  }

  const verified = await verifyPaymentTransaction(signature, {
    payer: intent.payer,
    method: intent.method,
    amount: intent.amount,
  });

  if (!verified.ok) {
    if (verified.reason === "not_found") {
      return NextResponse.json({ pending: true }, { status: 202 });
    }
    await logWebhook({
      outcome: `pay_confirm_rejected_${verified.reason}`,
      authHeader: "",
      headerNames: "",
      // Not request.nextUrl.search: it carries the raw nonce, which is stored
      // only as a hash everywhere else precisely so a DB leak can't replay it.
      query: `intentId=${intentId}`,
      body: JSON.stringify({ intentId, signature }),
    });
    return NextResponse.json(
      { error: "That transaction doesn't match what was quoted. Contact support with your transaction id." },
      { status: 403 }
    );
  }

  // `intent.quantity` credits, all keyed off this one verified signature. The
  // unique index on payment_id still makes a replayed confirm a no-op: the same
  // ids are computed, all conflict, and the existing tokens come back.
  //
  // The account comes from the INTENT, not the current cookie: the credits must
  // land on whoever quoted the purchase even if the session changed since.
  const claimTokens = await createCredits({
    paymentId: signature,
    method: intent.method,
    tier: intent.tier,
    quantity: intent.quantity,
    nonceHash: intent.nonceHash,
    payerWallet: intent.payer,
    userId: intent.userId,
  });
  if (!claimTokens || claimTokens.length === 0) {
    return NextResponse.json({ error: "Database not configured" }, { status: 503 });
  }

  // The first token is the one handed to the browser to use immediately; any
  // others are already sitting on the account balance.
  const claimToken = claimTokens[0];
  await consumePaymentIntent(intentId, signature, claimToken);

  return NextResponse.json({
    claimToken,
    tier: intent.tier,
    quantity: claimTokens.length,
  });
}
