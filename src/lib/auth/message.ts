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
 * prompts they haven't read.
 *
 * Changing a single character invalidates every in-flight nonce. That is
 * harmless (they expire in five minutes) but it must change in one place.
 */
export const SIGN_IN_DOMAIN = "Alpha Wallet Finder";

export function buildSignInMessage(wallet: string, nonce: string): string {
  return [
    `${SIGN_IN_DOMAIN} — sign in`,
    "",
    "Signing this message is FREE. It authorizes no transaction and moves no",
    "funds. It only proves you control this wallet, so your past purchases can",
    "be restored to it.",
    "",
    `Wallet: ${wallet}`,
    `Nonce: ${nonce}`,
  ].join("\n");
}
