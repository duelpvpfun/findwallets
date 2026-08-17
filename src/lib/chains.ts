import type { Chain } from "./types";

export const ALLOWED_CHAINS: Chain[] = ["solana", "bsc", "base"];

const SOLANA_ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const EVM_ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

export const CHAIN_LABELS: Record<Chain, string> = {
  solana: "Solana",
  bsc: "BNB Chain",
  base: "Base",
};

export function isChain(value: string): value is Chain {
  return (ALLOWED_CHAINS as string[]).includes(value);
}

export function isValidAddressForChain(chain: Chain, address: string): boolean {
  return chain === "solana" ? SOLANA_ADDRESS_RE.test(address) : EVM_ADDRESS_RE.test(address);
}

/** Which chain family an address *looks* like, regardless of what was selected. */
export function detectAddressFamily(address: string): "solana" | "evm" | null {
  if (EVM_ADDRESS_RE.test(address)) return "evm";
  if (SOLANA_ADDRESS_RE.test(address)) return "solana";
  return null;
}

/**
 * Explains a chain/address mismatch in the user's terms. A Solana CA submitted
 * under BNB Chain is the expensive mistake to catch: the formats are disjoint,
 * so it can be rejected before a single upstream call is billed.
 */
export function addressMismatchMessage(chain: Chain, address: string): string | null {
  const family = detectAddressFamily(address);
  const label = CHAIN_LABELS[chain];

  if (family === null) {
    return `That doesn't look like a ${label} contract address. Check for a missing or extra character.`;
  }
  if (chain === "solana" && family === "evm") {
    return `That's an EVM contract address, but ${label} is selected. Switch to BNB Chain or Base.`;
  }
  if (chain !== "solana" && family === "solana") {
    return `That's a Solana contract address, but ${label} is selected. Switch to Solana.`;
  }
  return null;
}

/** Sibling EVM chain — a 0x address is valid on both, so a "not found" on one
 * is worth suggesting the other. */
export function siblingEvmChain(chain: Chain): Chain | null {
  if (chain === "bsc") return "base";
  if (chain === "base") return "bsc";
  return null;
}
