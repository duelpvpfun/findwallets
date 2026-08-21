import { NextRequest, NextResponse } from "next/server";
import { isSolanaPubkey } from "@/lib/chains";
import { isDbConfigured } from "@/lib/db";
import { consumeAuthNonce, upsertUserAndClaimHistory } from "@/lib/db/users";
import { buildSignInMessage } from "@/lib/auth/message";
import { verifySignedMessage } from "@/lib/auth/signature";
import { issueSession, sessionCookieOptions } from "@/lib/auth/session";
import { clientIp, rateLimit } from "@/lib/rateLimit";

export const dynamic = "force-dynamic";

/**
 * Step 2 of Sign-In With Solana: verify the signature and issue a session.
 *
 * Three things make this safe, in order:
 *
 * 1. The nonce is claimed by an atomic `UPDATE ... WHERE used_at IS NULL`, so a
 *    replay finds it already used. It is claimed BEFORE the signature is
 *    checked, so a wrong guess burns the challenge instead of allowing another.
 * 2. The signed message is REBUILT from the wallet and the stored nonce. A
 *    client-supplied message body is never verified — otherwise a caller could
 *    have a wallet sign anything at all and present it here.
 * 3. Verification is Ed25519 over that reconstructed text. It is a signature, not
 *    a transaction: signing in costs the user zero lamports.
 */
const MAX_REQUESTS_PER_MINUTE = 12;

/** One message for every rejection, so a prober learns nothing about which
 * nonces exist, which are used, and which signatures were merely wrong. */
const REJECTED = "That sign-in could not be verified. Start again.";

export async function POST(request: NextRequest) {
  const limited = await rateLimit(
    `auth-verify:${clientIp(request)}`,
    MAX_REQUESTS_PER_MINUTE,
    60_000
  );
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
  const nonce = typeof body.nonce === "string" ? body.nonce.trim() : "";
  const signature = typeof body.signature === "string" ? body.signature.trim() : "";

  if (!isSolanaPubkey(wallet) || !nonce || !signature) {
    return NextResponse.json({ error: REJECTED }, { status: 400 });
  }

  try {
    // Claimed first: a failed signature must not leave the challenge reusable.
    const claim = await consumeAuthNonce(nonce, wallet);
    if (!claim.ok) {
      console.warn("[auth/verify] nonce rejected:", claim.reason);
      return NextResponse.json({ error: REJECTED }, { status: 401 });
    }

    // Reconstructed, never taken from the request.
    const message = buildSignInMessage(wallet, nonce);
    if (!verifySignedMessage(wallet, message, signature)) {
      return NextResponse.json({ error: REJECTED }, { status: 401 });
    }

    const user = await upsertUserAndClaimHistory(wallet);
    if (!user) {
      return NextResponse.json({ error: "Could not create your account." }, { status: 503 });
    }

    const session = issueSession(user);
    const response = NextResponse.json({
      user: { wallet: user.wallet, displayName: user.displayName },
    });
    response.cookies.set(session.name, session.value, sessionCookieOptions(session.maxAge));
    return response;
  } catch (err) {
    console.error("[auth/verify] failed:", err);
    return NextResponse.json({ error: "Sign-in failed. Try again." }, { status: 500 });
  }
}
