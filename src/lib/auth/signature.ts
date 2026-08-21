import "server-only";
import { createPublicKey, verify as cryptoVerify } from "node:crypto";
import bs58 from "bs58";

/**
 * Ed25519 verification for Sign-In With Solana.
 *
 * Uses Node's own crypto rather than `tweetnacl`: this is the check that decides
 * whether someone owns a wallet, and the platform's audited implementation is a
 * better place for that than a pure-JS one. It also means one fewer dependency
 * in the money path.
 *
 * A Solana public key is a bare 32-byte Ed25519 point, which `createPublicKey`
 * won't take directly — it wants SPKI DER. The 12-byte prefix below is the fixed
 * SPKI header for Ed25519 (`AlgorithmIdentifier { 1.3.101.112 }` + BIT STRING),
 * so prepending it turns the raw key into something OpenSSL recognises.
 */
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

const PUBLIC_KEY_BYTES = 32;
const SIGNATURE_BYTES = 64;

function decodeBase58(value: string, expectedBytes: number): Buffer | null {
  try {
    const bytes = Buffer.from(bs58.decode(value));
    return bytes.length === expectedBytes ? bytes : null;
  } catch {
    // Not valid base58. Indistinguishable from a wrong signature as far as the
    // caller is concerned, and treated the same way.
    return null;
  }
}

/**
 * True only when `signature` is a valid Ed25519 signature over `message` by
 * `walletBase58`.
 *
 * Never throws: every malformed input — bad base58, wrong length, a public key
 * that isn't a curve point — is a rejection, not an error. An exception here
 * would surface as a 500 and tell an attacker which of their inputs was wrong.
 */
export function verifySignedMessage(
  walletBase58: string,
  message: string,
  signatureBase58: string
): boolean {
  const publicKeyBytes = decodeBase58(walletBase58, PUBLIC_KEY_BYTES);
  const signatureBytes = decodeBase58(signatureBase58, SIGNATURE_BYTES);
  if (!publicKeyBytes || !signatureBytes) return false;

  try {
    const key = createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, publicKeyBytes]),
      format: "der",
      type: "spki",
    });
    // `null` algorithm: Ed25519 hashes internally, so no digest is passed.
    return cryptoVerify(null, Buffer.from(message, "utf8"), key, signatureBytes);
  } catch {
    return false;
  }
}
