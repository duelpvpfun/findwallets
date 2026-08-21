import { NextRequest, NextResponse } from "next/server";
import { TIER_OPTIONS } from "@/lib/tiers";
import { createPaymentIntent, type PaymentMethod } from "@/lib/db/paymentIntents";
import { buildPaymentTransaction, isSolanaPayConfigured, quoteAmount, USDC_MINT } from "@/lib/solanaPay";
import { isDbConfigured } from "@/lib/db";
import { clientIp, rateLimit } from "@/lib/rateLimit";
import { isSolanaPubkey } from "@/lib/chains";
import { MAX_CREDIT_QUANTITY } from "@/lib/db/credits";
import { getSessionUser } from "@/lib/auth/session";

/**
 * Quotes a purchase and returns an unsigned transaction for the buyer's wallet
 * to sign. The server decides the exact amount and instructions — the client
 * only ever supplies which tier/method/quantity it wants and its own public key.
 */
const MAX_REQUESTS_PER_MINUTE = 20;

export async function POST(request: NextRequest) {
  const limited = await rateLimit(`pay-init:${clientIp(request)}`, MAX_REQUESTS_PER_MINUTE, 60_000);
  if (!limited.ok) {
    return NextResponse.json(
      { error: "Too many requests. Slow down." },
      { status: 429, headers: { "Retry-After": String(limited.retryAfterSeconds) } }
    );
  }

  if (!isDbConfigured() || !isSolanaPayConfigured()) {
    return NextResponse.json({ error: "Payments are not configured." }, { status: 503 });
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const tier = Number(body.tier);
  const method = body.method;
  const nonce = typeof body.nonce === "string" ? body.nonce : "";
  const payer = typeof body.payer === "string" ? body.payer : "";
  const requestedQuantity = Number(body.quantity ?? 1);

  const tierInfo = TIER_OPTIONS.find((t) => t.limit === tier);
  if (!tierInfo) {
    return NextResponse.json({ error: "Unknown tier." }, { status: 400 });
  }
  if (method !== "sol" && method !== "usdc") {
    return NextResponse.json({ error: "Unknown payment method." }, { status: 400 });
  }
  if (nonce.length < 16) {
    return NextResponse.json({ error: "Missing nonce." }, { status: 400 });
  }
  if (!isSolanaPubkey(payer)) {
    return NextResponse.json({ error: "Invalid wallet address." }, { status: 400 });
  }
  if (
    !Number.isInteger(requestedQuantity) ||
    requestedQuantity < 1 ||
    requestedQuantity > MAX_CREDIT_QUANTITY
  ) {
    return NextResponse.json(
      { error: `Choose between 1 and ${MAX_CREDIT_QUANTITY} scans.` },
      { status: 400 }
    );
  }

  // Buying more than one requires an account, because that is the only place the
  // spare credits can live. An anonymous buyer holds exactly one claim token in
  // one browser, so extra credits would be unreachable the moment they closed
  // the tab — and /recover can only map a signature back to the first of them.
  const session = await getSessionUser();
  if (requestedQuantity > 1 && !session) {
    return NextResponse.json(
      { error: "Connect your wallet to buy more than one scan at a time." },
      { status: 403 }
    );
  }
  const quantity = session ? requestedQuantity : 1;

  try {
    // Quantity multiplies the quote, and the quoted figure is what gets verified
    // on-chain — so a client asking for 5 and paying for 1 fails verification.
    const amount = await quoteAmount(method as PaymentMethod, tierInfo.priceUsd * quantity);
    const intent = await createPaymentIntent({
      nonce,
      tier: tierInfo.limit,
      method: method as PaymentMethod,
      payer,
      amount,
      mint: method === "usdc" ? USDC_MINT : null,
      quantity,
      userId: session?.id ?? null,
    });
    if (!intent) {
      return NextResponse.json({ error: "Database not configured" }, { status: 503 });
    }

    const built = await buildPaymentTransaction(payer, method as PaymentMethod, amount);

    return NextResponse.json({
      intentId: intent.id,
      transaction: built.base64,
      amount,
      method,
      quantity,
      mint: method === "usdc" ? USDC_MINT : null,
      expiresAt: intent.expiresAt,
    });
  } catch (err) {
    console.error("[pay/init] failed:", err);
    return NextResponse.json({ error: "Could not prepare the payment. Try again." }, { status: 502 });
  }
}
