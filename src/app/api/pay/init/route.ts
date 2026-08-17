import { NextRequest, NextResponse } from "next/server";
import { TIER_OPTIONS } from "@/lib/tiers";
import { createPaymentIntent, type PaymentMethod } from "@/lib/db/paymentIntents";
import { buildPaymentTransaction, isSolanaPayConfigured, quoteAmount, USDC_MINT } from "@/lib/solanaPay";
import { isDbConfigured } from "@/lib/db";
import { clientIp, rateLimit } from "@/lib/rateLimit";

/**
 * Quotes a purchase and returns an unsigned transaction for the buyer's wallet
 * to sign. The server decides the exact amount and instructions — the client
 * only ever supplies which tier/method it wants and its own public key.
 */
const MAX_REQUESTS_PER_MINUTE = 20;

function isValidPubkeyShape(value: string): boolean {
  // Base58, 32-44 chars covers every real Solana public key without pulling in
  // web3.js just to validate a string shape.
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value);
}

export async function POST(request: NextRequest) {
  const limited = rateLimit(`pay-init:${clientIp(request)}`, MAX_REQUESTS_PER_MINUTE, 60_000);
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
  if (!isValidPubkeyShape(payer)) {
    return NextResponse.json({ error: "Invalid wallet address." }, { status: 400 });
  }

  try {
    const amount = await quoteAmount(method as PaymentMethod, tierInfo.priceUsd);
    const intent = await createPaymentIntent({
      nonce,
      tier: tierInfo.limit,
      method: method as PaymentMethod,
      payer,
      amount,
      mint: method === "usdc" ? USDC_MINT : null,
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
      mint: method === "usdc" ? USDC_MINT : null,
      expiresAt: intent.expiresAt,
    });
  } catch (err) {
    console.error("[pay/init] failed:", err);
    return NextResponse.json({ error: "Could not prepare the payment. Try again." }, { status: 502 });
  }
}
