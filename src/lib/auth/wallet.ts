import { detectAddressFamily } from "@/lib/chains";

/**
 * Which wallet families can hold an account, and how their addresses are stored.
 *
 * Shared by client and server on purpose. The signed message contains the wallet
 * address, so if the two sides disagreed about its canonical form by a single
 * character, the server would rebuild a different message than the one the
 * wallet signed and every sign-in would fail to verify.
 *
 * The two formats are disjoint (base58 vs `0x` + 40 hex), so one column holds
 * both without any risk of collision.
 */
export type WalletFamily = "solana" | "evm";

export const WALLET_FAMILY_LABELS: Record<WalletFamily, string> = {
  solana: "Solana",
  evm: "Ethereum",
};

export function walletFamily(wallet: string): WalletFamily | null {
  return detectAddressFamily(wallet.trim());
}

/**
 * The stored form of an address, or null if it is not a wallet at all.
 *
 * EVM addresses are lowercased: they are case-insensitive, and wallets disagree
 * about whether to hand back the EIP-55 checksummed mixed case. Without this,
 * `users_wallet_idx` would happily hold two accounts for the same person and
 * their credits would be split across both.
 *
 * Solana keys are left exactly as they are. Base58 is case-sensitive and the
 * string *is* the public key.
 */
export function normalizeWallet(wallet: string): string | null {
  const trimmed = wallet.trim();
  const family = detectAddressFamily(trimmed);
  if (family === null) return null;
  return family === "evm" ? trimmed.toLowerCase() : trimmed;
}

/** Truncated for display. Keeps the `0x` on EVM addresses, which reads as wrong without it. */
export function shortenWallet(wallet: string): string {
  return `${wallet.slice(0, wallet.startsWith("0x") ? 6 : 4)}…${wallet.slice(-4)}`;
}
