/**
 * The exact text a user signs to prove they own a wallet.
 *
 * Deliberately shared by client and server and derived from nothing but the
 * wallet and the stored nonce, so the server can rebuild it byte-for-byte at
 * verify time. Verifying against a message the *client* supplied would let a
 * caller sign anything at all — including a real transaction from some other
 * app — and present it here as a sign-in.
 *
 * The wording is part of the security model, not decoration: a wallet prompt
 * that doesn't say plainly that nothing is being spent trains people to approve
 * prompts they haven't read. It leads with the domain for the same reason it is
 * the first thing a phishing prompt gets wrong.
 *
 * SIGN_IN_HOST is a hardcoded brand constant, NOT derived from SITE_URL:
 * `VERCEL_PROJECT_PRODUCTION_URL` is server-only, so a derived host would
 * differ between the browser and the API and every signature would fail to
 * verify.
 *
 * Changing a single character invalidates every in-flight nonce. That is
 * harmless (they expire in five minutes) but it must change in one place.
 */
export const SIGN_IN_DOMAIN = "Alpha Wallet Finder";
export const SIGN_IN_HOST = "alphawallets.fun";

export function buildSignInMessage(wallet: string, nonce: string): string {
  return [
    SIGN_IN_HOST,
    `Sign in to ${SIGN_IN_DOMAIN}`,
    "",
    "This signature is free. It approves no transaction and moves no funds.",
    "It proves you own this wallet, so your purchases can be restored to it.",
    "",
    `Wallet: ${wallet}`,
    `Nonce: ${nonce}`,
  ].join("\n");
}
