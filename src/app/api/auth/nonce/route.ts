import { NextRequest, NextResponse } from "next/server";
import { normalizeWallet } from "@/lib/auth/wallet";
import { isDbConfigured } from "@/lib/db";
import { createAuthNonce, NONCE_TTL_MS } from "@/lib/db/users";
import { buildSignInMessage } from "@/lib/auth/message";
import { clientIp, rateLimit } from "@/lib/rateLimit";

export const dynamic = "force-dynamic";

/**
 * Step 1 of sign-in: hand out a single-use challenge bound to one wallet, plus
 * the exact message to sign. Solana and EVM wallets both come through here; the
 * address format is what decides which, and the challenge is identical either
 * way.
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

  // Normalized before it is stored, because the signed message contains this
  // string: the verify step rebuilds the message from the stored nonce, and a
  // checksummed EVM address here against a lowercased one there would produce a
  // different message than the wallet actually signed.
  const wallet = normalizeWallet(typeof body.wallet === "string" ? body.wallet : "");
  if (!wallet) {
    return NextResponse.json(
      { error: "That isn't a Solana or EVM wallet address." },
      { status: 400 }
    );
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
