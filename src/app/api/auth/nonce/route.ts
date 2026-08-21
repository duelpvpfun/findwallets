import { NextRequest, NextResponse } from "next/server";
import { isSolanaPubkey } from "@/lib/chains";
import { isDbConfigured } from "@/lib/db";
import { createAuthNonce, NONCE_TTL_MS } from "@/lib/db/users";
import { buildSignInMessage } from "@/lib/auth/message";
import { clientIp, rateLimit } from "@/lib/rateLimit";

export const dynamic = "force-dynamic";

/**
 * Step 1 of Sign-In With Solana: hand out a single-use challenge bound to one
 * wallet, plus the exact message to sign.
 *
 * The message is returned for display only. Verification rebuilds it
 * server-side from the stored nonce, so nothing here is trusted on the way back.
 */
const MAX_REQUESTS_PER_MINUTE = 12;

export async function POST(request: NextRequest) {
  const limited = await rateLimit(`auth-nonce:${clientIp(request)}`, MAX_REQUESTS_PER_MINUTE, 60_000);
  if (!limited.ok) {
    return NextResponse.json(
      { error: "Too many sign-in attempts. Wait a moment and try again." },
      { status: 429, headers: { "Retry-After": String(limited.retryAfterSeconds) } }
    );
  }

  if (!isDbConfigured()) {
    return NextResponse.json({ error: "Accounts are not available right now." }, { status: 503 });
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const wallet = typeof body.wallet === "string" ? body.wallet.trim() : "";
  if (!isSolanaPubkey(wallet)) {
    return NextResponse.json({ error: "That isn't a Solana wallet address." }, { status: 400 });
  }

  try {
    const nonce = await createAuthNonce(wallet);
    if (!nonce) {
      return NextResponse.json({ error: "Accounts are not available right now." }, { status: 503 });
    }

    return NextResponse.json({
      nonce,
      message: buildSignInMessage(wallet, nonce),
      expiresInMs: NONCE_TTL_MS,
    });
  } catch (err) {
    console.error("[auth/nonce] failed:", err);
    return NextResponse.json({ error: "Could not start sign-in. Try again." }, { status: 500 });
  }
}
