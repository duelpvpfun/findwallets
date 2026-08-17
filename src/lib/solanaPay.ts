import "server-only";
import {
  Connection,
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { fetchSolPriceUsd } from "./solanaTracker";
import type { PaymentMethod } from "./db/paymentIntents";

/** USDC mint on Solana mainnet. 6 decimals. */
export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const USDC_DECIMALS = 6;

export class SolanaPayError extends Error {}

function heliusApiKey(): string {
  const key = process.env.HELIUS_API_KEY;
  if (!key) throw new SolanaPayError("HELIUS_API_KEY is not configured.");
  return key;
}

function treasuryWallet(): string {
  const addr = process.env.SOLANA_TREASURY_WALLET;
  if (!addr) throw new SolanaPayError("SOLANA_TREASURY_WALLET is not configured.");
  return addr;
}

function heliusRpcUrl(): string {
  return `https://mainnet.helius-rpc.com/?api-key=${heliusApiKey()}`;
}

let connection: Connection | null = null;
/** Lazily created: constructing it eagerly would throw at import time in any
 * environment (build, tests) where the Helius key isn't set. */
function getConnection(): Connection {
  if (!connection) connection = new Connection(heliusRpcUrl(), "confirmed");
  return connection;
}

export function isSolanaPayConfigured(): boolean {
  return Boolean(process.env.HELIUS_API_KEY && process.env.SOLANA_TREASURY_WALLET);
}

/** Converts a USD tier price into the exact amount the buyer must send,
 * quoted once at intent-creation time and never recomputed afterward. */
export async function quoteAmount(method: PaymentMethod, priceUsd: number): Promise<number> {
  if (method === "usdc") {
    return Math.round(priceUsd * 10 ** USDC_DECIMALS);
  }
  const solPriceUsd = await fetchSolPriceUsd();
  if (!(solPriceUsd > 0)) throw new SolanaPayError("Could not price SOL right now.");
  return Math.round((priceUsd / solPriceUsd) * 1e9);
}

export interface BuiltTransaction {
  /** Base64-encoded, unsigned transaction ready for the wallet to sign. */
  base64: string;
  blockhash: string;
  lastValidBlockHeight: number;
}

/**
 * Builds a plain, single-purpose transfer — either a native SOL transfer or a
 * standard SPL token transfer to our treasury wallet. Deliberately nothing
 * else: no delegate/approve instructions, no unfamiliar programs, so wallet
 * simulators (Phantom/Blowfish) have a simple, legible transaction to show.
 */
export async function buildPaymentTransaction(
  payer: string,
  method: PaymentMethod,
  amount: number
): Promise<BuiltTransaction> {
  const payerKey = new PublicKey(payer);
  const treasuryKey = new PublicKey(treasuryWallet());
  const conn = getConnection();
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");

  const tx = new Transaction({ feePayer: payerKey, blockhash, lastValidBlockHeight });

  if (method === "sol") {
    tx.add(SystemProgram.transfer({ fromPubkey: payerKey, toPubkey: treasuryKey, lamports: amount }));
  } else {
    const mintKey = new PublicKey(USDC_MINT);
    const fromAta = getAssociatedTokenAddressSync(mintKey, payerKey);
    const toAta = getAssociatedTokenAddressSync(mintKey, treasuryKey);
    // Idempotent so this never fails if the treasury ATA already exists; the
    // buyer's own ATA is not created here — if they have no USDC account they
    // have no USDC, and the transfer instruction fails naturally.
    tx.add(
      createAssociatedTokenAccountIdempotentInstruction(payerKey, toAta, treasuryKey, mintKey)
    );
    tx.add(
      createTransferCheckedInstruction(
        fromAta,
        mintKey,
        toAta,
        payerKey,
        amount,
        USDC_DECIMALS,
        [],
        TOKEN_PROGRAM_ID
      )
    );
  }

  const base64 = tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64");
  return { base64, blockhash, lastValidBlockHeight };
}

export interface VerifiedTransfer {
  ok: boolean;
  reason?: string;
}

/**
 * Re-derives what the transaction actually moved on-chain from Helius's
 * `getTransaction` response and checks it against the quoted intent. Balance
 * deltas are used rather than parsing instructions, since deltas can't lie
 * about what value actually changed hands regardless of instruction shape.
 */
export async function verifyPaymentTransaction(
  signature: string,
  intent: { payer: string; method: string; amount: number }
): Promise<VerifiedTransfer> {
  const res = await fetch(heliusRpcUrl(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "verify",
      method: "getTransaction",
      params: [signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 }],
    }),
    cache: "no-store",
  });
  if (!res.ok) return { ok: false, reason: "rpc_error" };

  const json = await res.json();
  const tx = json?.result;
  if (!tx) return { ok: false, reason: "not_found" };
  if (tx.meta?.err) return { ok: false, reason: "tx_failed" };

  const accountKeys: string[] = tx.transaction?.message?.accountKeys ?? [];
  if (accountKeys[0] !== intent.payer) return { ok: false, reason: "payer_mismatch" };

  if (intent.method === "sol") {
    const treasuryIndex = accountKeys.indexOf(treasuryWallet());
    if (treasuryIndex === -1) return { ok: false, reason: "no_treasury_transfer" };
    const pre = tx.meta.preBalances?.[treasuryIndex];
    const post = tx.meta.postBalances?.[treasuryIndex];
    if (typeof pre !== "number" || typeof post !== "number") return { ok: false, reason: "no_balances" };
    if (post - pre !== intent.amount) return { ok: false, reason: "amount_mismatch" };
    return { ok: true };
  }

  const preEntry = (tx.meta.preTokenBalances ?? []).find(
    (b: { mint: string; owner?: string }) => b.mint === USDC_MINT && b.owner === treasuryWallet()
  );
  const postEntry = (tx.meta.postTokenBalances ?? []).find(
    (b: { mint: string; owner?: string }) => b.mint === USDC_MINT && b.owner === treasuryWallet()
  );
  const preAmount = Number(preEntry?.uiTokenAmount?.amount ?? "0");
  const postAmount = Number(postEntry?.uiTokenAmount?.amount ?? "0");
  if (!postEntry) return { ok: false, reason: "no_treasury_transfer" };
  if (postAmount - preAmount !== intent.amount) return { ok: false, reason: "amount_mismatch" };
  return { ok: true };
}
