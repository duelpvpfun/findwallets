"use client";

/**
 * The injected EVM provider, for wallets that are not Solana.
 *
 * The tool ranks BNB Chain and Base as well as Solana, so a good share of
 * customers arrive with MetaMask or Rabby and nothing else. Sign-in used to be
 * Ed25519-only, which meant those people could not have an account at all, and
 * without an account a purchase lives and dies with their localStorage.
 *
 * Deliberately raw EIP-1193 rather than wagmi/viem: all this needs is one
 * `eth_requestAccounts` and one `personal_sign`. There is no chain to switch, no
 * contract to read and no transaction to send, because signing in is free.
 */

export interface EvmProvider {
  isMetaMask?: boolean;
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
}

export function getEvmProvider(): EvmProvider | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    phantom?: { ethereum?: EvmProvider };
    ethereum?: EvmProvider;
  };
  // Phantom injects an EVM provider of its own. `window.ethereum` is checked
  // first so a visitor with a dedicated EVM wallet installed gets that one.
  return w.ethereum ?? w.phantom?.ethereum ?? null;
}

export const EVM_INSTALL_URL = "https://metamask.io/download/";

/** `personal_sign` wants hex, not a byte array, and MetaMask renders it as text. */
function toHex(message: string): string {
  const bytes = new TextEncoder().encode(message);
  let out = "0x";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

/**
 * Connects, then signs. Returns the address exactly as the wallet reported it;
 * the caller normalizes, because the normalized form is what goes into the
 * signed message.
 */
export async function connectEvm(provider: EvmProvider): Promise<string | null> {
  const accounts = (await provider.request({ method: "eth_requestAccounts" })) as unknown;
  if (!Array.isArray(accounts) || typeof accounts[0] !== "string") return null;
  return accounts[0];
}

/**
 * A `personal_sign` signature over `message`, as `0x` + 130 hex characters.
 *
 * Never `eth_sendTransaction` and never `eth_signTypedData` for a contract call:
 * this is the same guarantee the Solana path makes, that signing in costs
 * nothing. The address is passed second because that is the parameter order
 * `personal_sign` takes.
 */
export async function signEvmMessage(
  provider: EvmProvider,
  address: string,
  message: string
): Promise<string | null> {
  const signature = await provider.request({
    method: "personal_sign",
    params: [toHex(message), address],
  });
  return typeof signature === "string" ? signature : null;
}
