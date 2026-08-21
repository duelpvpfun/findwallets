/**
 * Turns a Helius enhanced transaction into the buys and sells we care about.
 *
 * Deliberately does NOT trust Helius's `type` field or its `events.swap` block.
 * Both are best-effort parses that vary by DEX and go missing on newer venues;
 * what never varies is the balance deltas, and a swap has a shape no transfer
 * or airdrop can imitate:
 *
 *     the wallet's balance of exactly one non-quote mint went UP,
 *     and in the same transaction a quote asset (SOL/USDC/USDT) went DOWN.
 *
 * That single rule is what keeps airdrops, transfers between a trader's own
 * wallets, LP operations and dust-spam out of the feed. A false alert costs a
 * subscriber; a missed one costs nothing but the alert.
 *
 * Pure functions only — no database, no network, no env. Everything the caller
 * needs to price the trade is passed in, which is also what makes this testable
 * against a captured transaction.
 */
import {
  IGNORED_SUBJECT_MINTS,
  QUOTE_MINTS,
  STABLE_MINTS,
  WSOL_MINT,
} from "./config";

// --- The subset of Helius's enhanced payload this depends on ---

export interface HeliusTokenBalanceChange {
  userAccount?: string | null;
  tokenAccount?: string | null;
  mint?: string | null;
  rawTokenAmount?: { tokenAmount?: string | null; decimals?: number | null } | null;
}

export interface HeliusAccountData {
  account?: string | null;
  nativeBalanceChange?: number | null;
  tokenBalanceChanges?: HeliusTokenBalanceChange[] | null;
}

export interface HeliusTokenTransfer {
  fromUserAccount?: string | null;
  toUserAccount?: string | null;
  mint?: string | null;
  tokenAmount?: number | string | null;
}

export interface HeliusEnhancedTransaction {
  signature?: string | null;
  timestamp?: number | null;
  type?: string | null;
  source?: string | null;
  fee?: number | null;
  feePayer?: string | null;
  transactionError?: unknown;
  accountData?: HeliusAccountData[] | null;
  tokenTransfers?: HeliusTokenTransfer[] | null;
}

/** One classified trade. `amountUsd` is the quote side — what was actually
 * spent or received — never a mark-to-market of the token leg. */
export interface ClassifiedEvent {
  signature: string;
  wallet: string;
  mint: string;
  side: "buy" | "sell";
  amountUsd: number;
  tokenAmount: number;
  /** Implied execution price, `amountUsd / tokenAmount`. Null when the token
   * amount is zero, which would otherwise divide to Infinity. */
  priceUsd: number | null;
  blockTime: Date;
}

/** Why a transaction produced nothing, for the debug endpoint. Never logged in
 * bulk — at production volume that is the noisiest line in the system. */
export type SkipReason =
  | "failed-transaction"
  | "no-signature"
  | "no-balance-change"
  | "no-quote-leg"
  | "no-subject-mint"
  | "ambiguous-subject"
  | "quote-only"
  | "zero-value";

export interface ClassifyResult {
  events: ClassifiedEvent[];
  /** One per (transaction, wallet) pair that produced nothing. */
  skipped: Array<{ wallet: string; reason: SkipReason }>;
}

const LAMPORTS_PER_SOL = 1_000_000_000;

/** Tokens whose net movement is smaller than this are rounding noise from a
 * route's intermediate hops, not the trade. */
const DUST_TOKEN_AMOUNT = 1e-9;

function toNumber(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Net balance change per mint for one wallet, from `accountData`.
 *
 * `accountData` is used rather than `tokenTransfers` because it reports the
 * wallet's *net* position change. A multi-hop route shows the same mint moving
 * through four transfer legs, and summing those legs double-counts; the account
 * delta is one number and is already net of every hop.
 */
function tokenDeltas(tx: HeliusEnhancedTransaction, wallet: string): Map<string, number> {
  const deltas = new Map<string, number>();

  for (const account of tx.accountData ?? []) {
    for (const change of account.tokenBalanceChanges ?? []) {
      if (change.userAccount !== wallet) continue;
      const mint = change.mint;
      if (!mint) continue;
      const raw = toNumber(change.rawTokenAmount?.tokenAmount);
      const decimals = toNumber(change.rawTokenAmount?.decimals);
      if (raw === 0) continue;
      deltas.set(mint, (deltas.get(mint) ?? 0) + raw / 10 ** decimals);
    }
  }

  // Fallback for payloads that carry transfers but no account data. Netted the
  // same way, so a multi-hop route still collapses to one figure per mint.
  if (deltas.size === 0) {
    for (const transfer of tx.tokenTransfers ?? []) {
      const mint = transfer.mint;
      if (!mint) continue;
      const amount = toNumber(transfer.tokenAmount);
      if (amount === 0) continue;
      if (transfer.toUserAccount === wallet) deltas.set(mint, (deltas.get(mint) ?? 0) + amount);
      if (transfer.fromUserAccount === wallet) deltas.set(mint, (deltas.get(mint) ?? 0) - amount);
    }
  }

  return deltas;
}

/**
 * Net SOL change for the wallet, in SOL, with the network fee added back.
 *
 * The fee is on the same account as the trade, so without this every buy reads
 * as very slightly larger than it was and — far worse — a wallet that merely
 * paid a fee and received a token would look like it had bought one.
 */
function nativeDeltaSol(tx: HeliusEnhancedTransaction, wallet: string): number {
  let lamports = 0;
  for (const account of tx.accountData ?? []) {
    if (account.account === wallet) lamports += toNumber(account.nativeBalanceChange);
  }
  if (tx.feePayer === wallet) lamports += toNumber(tx.fee);
  return lamports / LAMPORTS_PER_SOL;
}

/**
 * Classify one transaction for a set of wallets we are tracking.
 *
 * `solPriceUsd` prices the SOL leg. A zero or missing price makes every
 * SOL-quoted trade worth $0, which the caller's minimum-size filter then drops
 * — so the caller must treat an unavailable SOL price as an outage, not as a
 * quiet day.
 */
export function classifyTransaction(
  tx: HeliusEnhancedTransaction,
  trackedWallets: ReadonlySet<string>,
  solPriceUsd: number
): ClassifyResult {
  const events: ClassifiedEvent[] = [];
  const skipped: ClassifyResult["skipped"] = [];

  const signature = tx.signature ?? "";
  if (!signature) return { events, skipped: [{ wallet: "", reason: "no-signature" }] };
  // A reverted transaction still reaches the webhook and still lists the
  // instructions it attempted. None of it happened.
  if (tx.transactionError) {
    return { events, skipped: [{ wallet: "", reason: "failed-transaction" }] };
  }

  const blockTime = new Date((tx.timestamp ?? Math.floor(Date.now() / 1000)) * 1000);

  // Only the wallets present in this transaction, so a 500-address webhook
  // payload does not walk the whole roster per transaction.
  const involved = new Set<string>();
  for (const account of tx.accountData ?? []) {
    if (account.account && trackedWallets.has(account.account)) involved.add(account.account);
    for (const change of account.tokenBalanceChanges ?? []) {
      if (change.userAccount && trackedWallets.has(change.userAccount)) {
        involved.add(change.userAccount);
      }
    }
  }
  for (const transfer of tx.tokenTransfers ?? []) {
    if (transfer.fromUserAccount && trackedWallets.has(transfer.fromUserAccount)) {
      involved.add(transfer.fromUserAccount);
    }
    if (transfer.toUserAccount && trackedWallets.has(transfer.toUserAccount)) {
      involved.add(transfer.toUserAccount);
    }
  }

  for (const wallet of involved) {
    const deltas = tokenDeltas(tx, wallet);
    const solDelta = nativeDeltaSol(tx, wallet);

    if (deltas.size === 0 && Math.abs(solDelta) < DUST_TOKEN_AMOUNT) {
      skipped.push({ wallet, reason: "no-balance-change" });
      continue;
    }

    // The quote side, in USD. Wrapped SOL counts as SOL: wrapping shows as
    // native out and WSOL in, which would otherwise net to a free trade.
    const wsolDelta = deltas.get(WSOL_MINT) ?? 0;
    let quoteDeltaUsd = (solDelta + wsolDelta) * solPriceUsd;
    for (const mint of STABLE_MINTS) quoteDeltaUsd += deltas.get(mint) ?? 0;

    // Candidate subjects: everything that is not a quote asset or a bluechip.
    const subjects = [...deltas.entries()].filter(
      ([mint, amount]) =>
        !QUOTE_MINTS.has(mint) &&
        !IGNORED_SUBJECT_MINTS.has(mint) &&
        Math.abs(amount) > DUST_TOKEN_AMOUNT
    );

    if (subjects.length === 0) {
      skipped.push({ wallet, reason: deltas.size > 0 ? "quote-only" : "no-subject-mint" });
      continue;
    }

    const side: "buy" | "sell" = quoteDeltaUsd < 0 ? "buy" : "sell";
    // The token leg must move opposite the quote leg. Everything else — an
    // airdrop landing while the wallet happens to be buying something else, a
    // transfer out — fails here.
    const matching = subjects.filter(([, amount]) => (side === "buy" ? amount > 0 : amount < 0));

    if (matching.length === 0) {
      skipped.push({ wallet, reason: "no-quote-leg" });
      continue;
    }
    // Two memecoins bought against one pot of SOL: there is no honest way to
    // split the quote amount between them, and inventing one would report a
    // size nobody traded. Skipping is the conservative answer, and this shape is
    // rare outside of routing bots.
    if (matching.length > 1) {
      skipped.push({ wallet, reason: "ambiguous-subject" });
      continue;
    }

    const [mint, tokenDelta] = matching[0];
    const amountUsd = Math.abs(quoteDeltaUsd);
    if (amountUsd <= 0) {
      skipped.push({ wallet, reason: "zero-value" });
      continue;
    }

    const tokenAmount = Math.abs(tokenDelta);
    events.push({
      signature,
      wallet,
      mint,
      side,
      amountUsd,
      tokenAmount,
      priceUsd: tokenAmount > 0 ? amountUsd / tokenAmount : null,
      blockTime,
    });
  }

  return { events, skipped };
}

/** Classify a whole webhook body. */
export function classifyBatch(
  transactions: HeliusEnhancedTransaction[],
  trackedWallets: ReadonlySet<string>,
  solPriceUsd: number
): ClassifyResult {
  const events: ClassifiedEvent[] = [];
  const skipped: ClassifyResult["skipped"] = [];
  for (const tx of transactions) {
    const result = classifyTransaction(tx, trackedWallets, solPriceUsd);
    events.push(...result.events);
    skipped.push(...result.skipped);
  }
  return { events, skipped };
}
