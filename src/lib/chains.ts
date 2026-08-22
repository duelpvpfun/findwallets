import type { Chain } from "./types";

export const ALLOWED_CHAINS: Chain[] = ["solana", "bsc", "base", "robinhood"];

/** The EVM members of `Chain`. Derived lists beat hand-written ones here: the
 * wrong-chain hints below name every alternative, and a chain missing from one
 * of them reads to the user as "that chain does not exist". */
export const EVM_CHAINS: Chain[] = ALLOWED_CHAINS.filter((c) => c !== "solana");

const SOLANA_ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const EVM_ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

export const CHAIN_LABELS: Record<Chain, string> = {
  solana: "Solana",
  bsc: "BNB Chain",
  base: "Base",
  robinhood: "Robinhood",
};

/**
 * Label for a chain that arrives as an unvalidated string — a `chain` column is
 * `text`, so a row could name a chain this build has never heard of. Falls back
 * to the raw value rather than rendering "undefined".
 */
export function chainLabel(value: string): string {
  return isChain(value) ? CHAIN_LABELS[value] : value;
}

export function isChain(value: string): value is Chain {
  return (ALLOWED_CHAINS as string[]).includes(value);
}

export function isValidAddressForChain(chain: Chain, address: string): boolean {
  return chain === "solana" ? SOLANA_ADDRESS_RE.test(address) : EVM_ADDRESS_RE.test(address);
}

/**
 * The form an address is stored and compared in.
 *
 * EVM addresses are case-insensitive on chain, but nobody agrees on a casing:
 * Birdeye returns them checksummed and a buyer pastes whatever they copied. The
 * `(chain, address)` unique keys are case-sensitive, so the same token arriving
 * in two casings minted two `tokens` rows and split its trade history between
 * them — three BNB Chain tokens had done exactly that, including the one serving
 * the free sample.
 *
 * Solana is returned untouched. Base58 is genuinely case-sensitive and
 * lowercasing a mint address yields a different, wrong address.
 */
export function normalizeAddress(chain: Chain, address: string): string {
  return chain === "solana" ? address : address.toLowerCase();
}

/**
 * Shape check for a Solana public key: base58, 32-44 characters. Covers every
 * real key without pulling in web3.js to validate a string.
 *
 * A wallet address and a token mint are the same shape, so payment quoting and
 * sign-in share this rather than each carrying its own copy of the regex.
 * A shape check is not a curve check — the signature verification in
 * `src/lib/auth/signature.ts` is what proves a key is real.
 */
export function isSolanaPubkey(value: string): boolean {
  return SOLANA_ADDRESS_RE.test(value);
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
    return `That's an EVM contract address, but ${label} is selected. Switch to ${listChains(EVM_CHAINS)}.`;
  }
  if (chain !== "solana" && family === "solana") {
    return `That's a Solana contract address, but ${label} is selected. Switch to Solana.`;
  }
  return null;
}

/**
 * The other EVM chains — a 0x address is valid on all of them, so a "not found"
 * on one is worth suggesting the rest.
 *
 * Returns a list rather than a single chain. With only BNB Chain and Base there
 * was exactly one alternative and naming it was free; with a third, picking one
 * to mention would send half the wrong-chain pastes to the wrong suggestion.
 */
export function siblingEvmChains(chain: Chain): Chain[] {
  if (chain === "solana") return [];
  return EVM_CHAINS.filter((c) => c !== chain);
}

/** "BNB Chain, Base or Robinhood" — an Oxford-less list for user-facing copy. */
export function listChains(chains: Chain[]): string {
  const labels = chains.map((c) => CHAIN_LABELS[c]);
  if (labels.length <= 1) return labels[0] ?? "";
  return `${labels.slice(0, -1).join(", ")} or ${labels[labels.length - 1]}`;
}
