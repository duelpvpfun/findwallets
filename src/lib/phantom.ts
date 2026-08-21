"use client";

/**
 * The browser wallet provider, in one place.
 *
 * Phantom (and every wallet that mimics its interface) injects at either
 * `window.phantom.solana` or `window.solana`. Both the paywall and the sign-in
 * button need this, and two copies of the detection logic is how they drift
 * apart.
 */

export interface SolanaProvider {
  isPhantom?: boolean;
  publicKey?: { toString(): string } | null;
  connect(opts?: { onlyIfTrusted?: boolean }): Promise<{ publicKey: { toString(): string } }>;
  /**
   * Signs a message. Free — no transaction, no lamports. This is what sign-in
   * uses; it must never be `signAndSendTransaction`.
   */
  signMessage(
    message: Uint8Array,
    display?: "utf8" | "hex"
  ): Promise<{ signature: Uint8Array; publicKey?: { toString(): string } }>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  signAndSendTransaction(transaction: any): Promise<{ signature: string }>;
}

export function getProvider(): SolanaProvider | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { phantom?: { solana?: SolanaProvider }; solana?: SolanaProvider };
  return w.phantom?.solana ?? w.solana ?? null;
}

export const PHANTOM_INSTALL_URL = "https://phantom.app/download";

/** Opens the install page for a visitor with no wallet at all. */
export function openWalletInstall(): void {
  window.open(PHANTOM_INSTALL_URL, "_blank", "noopener,noreferrer");
}

/**
 * Turns a thrown wallet error into something a person can act on. Phantom
 * reports a user-cancelled prompt as an ordinary rejection, and "Error: User
 * rejected the request" in a red box reads like the site broke.
 */
export function walletErrorMessage(err: unknown, cancelledMessage: string): string | null {
  const msg = (err instanceof Error ? err.message : "").toLowerCase();
  if (msg.includes("reject") || msg.includes("cancel") || msg.includes("denied")) {
    return cancelledMessage;
  }
  return null;
}

/**
 * Solana wallets hand back a signature as raw bytes; the server wants base58.
 * Encoded here rather than server-side because the byte array does not survive
 * JSON transport intact.
 */
export async function encodeSignature(signature: Uint8Array): Promise<string> {
  const bs58 = (await import("bs58")).default;
  return bs58.encode(signature);
}
