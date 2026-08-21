import "server-only";
import { createPublicKey, verify as cryptoVerify } from "node:crypto";
import bs58 from "bs58";
import { secp256k1 } from "@noble/curves/secp256k1";
import { keccak_256 } from "@noble/hashes/sha3";
import { walletFamily } from "./wallet";

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

/* -------------------------------------------------------------------------- */
/* EVM                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * `personal_sign` verification for EVM wallets.
 *
 * Unlike Ed25519 there is no platform primitive to lean on: recovering a public
 * key from an ECDSA signature is not exposed by `node:crypto`, and keccak-256 is
 * not a Node hash. `@noble/curves` and `@noble/hashes` are the audited
 * implementations that ethers and viem themselves use, and they were already in
 * the tree via @solana/web3.js. They are direct dependencies now for the same
 * reason bs58 is: something in the money path must not depend on a transitive
 * hoist surviving the next lockfile change.
 *
 * Verification is by recovery, not by comparison: we recover the address that
 * produced the signature and check it is the one claiming to have signed. There
 * is nothing else to compare against, since an EVM address is a hash of a public
 * key rather than the key itself.
 */
const EIP191_PREFIX = "\u0019Ethereum Signed Message:\n";

/** r(32) + s(32) + v(1), which is what every wallet returns from personal_sign. */
const EVM_SIGNATURE_BYTES = 65;

function eip191Digest(message: string): Uint8Array {
  const body = Buffer.from(message, "utf8");
  // The length in the prefix is the BYTE length, not the character count. A
  // message with any non-ASCII character in it verifies wrong if this is
  // `message.length`.
  return keccak_256(Buffer.concat([Buffer.from(`${EIP191_PREFIX}${body.length}`, "utf8"), body]));
}

function addressFromPublicKey(uncompressed: Uint8Array): string {
  // Drop the 0x04 uncompressed tag, keccak the 64-byte body, keep the last 20.
  const hashed = keccak_256(uncompressed.subarray(1));
  return `0x${Buffer.from(hashed.subarray(12)).toString("hex")}`;
}

function decodeHex(value: string, expectedBytes: number): Buffer | null {
  const body = value.startsWith("0x") || value.startsWith("0X") ? value.slice(2) : value;
  if (body.length !== expectedBytes * 2 || !/^[0-9a-fA-F]+$/.test(body)) return null;
  return Buffer.from(body, "hex");
}

/**
 * True only when `signature` is a `personal_sign` signature over `message` by
 * `address`.
 *
 * Never throws, for the same reason the Ed25519 path doesn't: a malformed input
 * is a rejection. An exception would surface as a 500 and tell a prober which
 * of their inputs was the wrong one.
 *
 * Smart-contract wallets (EIP-1271) are not supported. They have no key to
 * recover, so ownership can only be proven by an on-chain call, and a Safe
 * cannot pay us in SOL anyway.
 */
export function verifyEvmSignedMessage(
  address: string,
  message: string,
  signature: string
): boolean {
  const raw = decodeHex(signature, EVM_SIGNATURE_BYTES);
  if (!raw) return false;

  // Wallets are split on whether the recovery id is EIP-155 style (27/28) or
  // bare (0/1). Both appear in the wild; anything else is not a signature we
  // produced a prompt for.
  const v = raw[64];
  const recovery = v === 27 || v === 28 ? v - 27 : v;
  if (recovery !== 0 && recovery !== 1) return false;

  try {
    const digest = eip191Digest(message);
    const recovered = secp256k1.Signature.fromCompact(raw.subarray(0, 64))
      .addRecoveryBit(recovery)
      .recoverPublicKey(digest)
      .toRawBytes(false);
    return addressFromPublicKey(recovered) === address.toLowerCase();
  } catch {
    // Not a point on the curve, s out of range, unrecoverable signature.
    return false;
  }
}

/**
 * The one entry point the verify route uses. Dispatches on the address format,
 * which is what decides the family: the two are disjoint, so there is nothing
 * for a caller to assert and nothing to get wrong.
 */
export function verifyWalletSignature(
  wallet: string,
  message: string,
  signature: string
): boolean {
  switch (walletFamily(wallet)) {
    case "solana":
      return verifySignedMessage(wallet, message, signature);
    case "evm":
      return verifyEvmSignedMessage(wallet, message, signature);
    default:
      return false;
  }
}
