import "server-only";
import {
  attachTokenSnapshot,
  claimTier,
  markOutOfBand,
  countWindows,
  currentEpisode,
  fetchRoster,
  fetchCallAnchorMessageId,
  fetchWindowBuyers,
  highestTierReached,
  insertEvents,
  markDelivered,
  type RosterEntry,
} from "../db/alerts";
import type { AlertWalletSnapshot } from "../db/schema";
import { classifyBatch, type ClassifiedEvent, type HeliusEnhancedTransaction } from "./classify";
import {
  MAX_ALERT_MCAP_USD,
  MAX_SOLD_SHARE,
  MIN_ALERT_MCAP_USD,
  MIN_BUY_USD,
  TELEGRAM_MIN_TIER,
} from "./config";
import { fetchAlertTokenSnapshot, solPriceUsd } from "./pricing";
import {
  buildAlertButtons,
  buildAlertMessage,
  buildRawLine,
  isTelegramConfigured,
  sendAlertMessage,
  sendPlainMessage,
} from "./telegram";

/**
 * The whole alert pipeline, from a Helius delivery to a Telegram message.
 *
 * Split out of the route so the route stays a thin auth-and-respond shell, and
 * so this can be driven from a script against captured transactions without a
 * server.
 *
 * Two constraints shape every line of it:
 *
 *  1. **Database calls run in sequence, never concurrently.** See AGENTS.md — a
 *     `Promise.all` here is a latent hang, not a speed-up.
 *  2. **Nothing throws.** A delivery that 500s is retried by Helius, and enough
 *     consecutive failures get the webhook auto-disabled — which has already
 *     happened once on this account. Failing quietly and returning 200 is
 *     strictly safer than failing loudly.
 */

const CHAIN = "solana";

/** Most tokens one delivery will escalate in a single pass. A delivery touching
 * more than this is either a bot storm or a bug; the excess is logged rather
 * than silently dropped, and the next delivery picks it up anyway because the
 * window is still open. */
const MAX_TOKENS_PER_DELIVERY = 12;

/** Wallets stored on the alert row. The message shows fewer; the rest are there
 * for the on-site feed and for anyone auditing the call later. */
const MAX_STORED_WALLETS = 25;

/** Wallets named in the Telegram message. Past this it stops being scannable in
 * a chat and becomes a wall of addresses; a 20-wallet accumulation alert would
 * fill a phone screen on its own. The block states how many were withheld. */
const MAX_MESSAGE_WALLETS = 4;

export interface DeliveryReport {
  transactions: number;
  classified: number;
  inserted: number;
  tokensChecked: number;
  fired: Array<{ tokenAddress: string; tier: number; wallets: number }>;
  solPriceStale: boolean;
  skipped: Record<string, number>;
}

/** Every address in a delivery that could plausibly be one of ours, so the
 * roster lookup is a handful of keys rather than the whole table. */
function candidateAddresses(transactions: HeliusEnhancedTransaction[]): string[] {
  const seen = new Set<string>();
  for (const tx of transactions) {
    for (const account of tx.accountData ?? []) {
      if (account.account) seen.add(account.account);
      for (const change of account.tokenBalanceChanges ?? []) {
        if (change.userAccount) seen.add(change.userAccount);
      }
    }
    for (const transfer of tx.tokenTransfers ?? []) {
      if (transfer.fromUserAccount) seen.add(transfer.fromUserAccount);
      if (transfer.toUserAccount) seen.add(transfer.toUserAccount);
    }
  }
  return [...seen];
}

function mean(values: Array<number | null>): number | null {
  const usable = values.filter((v): v is number => v !== null && Number.isFinite(v));
  if (usable.length === 0) return null;
  return usable.reduce((a, b) => a + b, 0) / usable.length;
}

/**
 * Handle one webhook body.
 *
 * Returns a report rather than throwing, and the caller responds 200 regardless
 * — a delivery we could not process is not a delivery Helius should retry
 * forever.
 */
export async function processDelivery(
  transactions: HeliusEnhancedTransaction[]
): Promise<DeliveryReport> {
  const report: DeliveryReport = {
    transactions: transactions.length,
    classified: 0,
    inserted: 0,
    tokensChecked: 0,
    fired: [],
    solPriceStale: false,
    skipped: {},
  };
  if (transactions.length === 0) return report;

  const { price, stale } = await solPriceUsd();
  report.solPriceStale = stale;

  const roster = await fetchRoster(CHAIN, candidateAddresses(transactions));
  if (roster.size === 0) return report;

  const { events, skipped } = classifyBatch(transactions, new Set(roster.keys()), price);
  for (const s of skipped) report.skipped[s.reason] = (report.skipped[s.reason] ?? 0) + 1;
  report.classified = events.length;
  if (events.length === 0) return report;

  const inserted = await insertEvents(CHAIN, events);
  report.inserted = inserted.length;
  if (inserted.length === 0) return report;

  if (rawModeEnabled()) await postRawLines(events, inserted, roster);

  // Only tokens with a genuinely new buy can have crossed a tier. A sell, or a
  // duplicate delivery of a buy we already had, changes no count.
  const tokensToCheck = [
    ...new Set(inserted.filter((r) => r.side === "buy").map((r) => r.tokenAddress)),
  ];
  if (tokensToCheck.length > MAX_TOKENS_PER_DELIVERY) {
    console.warn(
      `[alerts] delivery touched ${tokensToCheck.length} tokens; checking the first ${MAX_TOKENS_PER_DELIVERY}`
    );
  }

  for (const tokenAddress of tokensToCheck.slice(0, MAX_TOKENS_PER_DELIVERY)) {
    report.tokensChecked++;
    try {
      const fired = await evaluateToken(tokenAddress);
      if (fired) report.fired.push(fired);
    } catch (err) {
      console.error(`[alerts] evaluating ${tokenAddress} failed:`, err);
    }
  }

  return report;
}

/**
 * Decide whether a token has crossed a tier, and announce it if so.
 *
 * Everything after the claim is best-effort: once `claimTier` returns a row the
 * alert exists, is in the feed, and is being tracked. A failed Telegram send is
 * recorded on the row and costs one message, not the alert.
 */
async function evaluateToken(
  tokenAddress: string
): Promise<{ tokenAddress: string; tier: number; wallets: number } | null> {
  const episode = await currentEpisode(CHAIN, tokenAddress);
  const counts = await countWindows(CHAIN, tokenAddress);
  const tier = highestTierReached(counts);
  if (!tier) return null;

  const buyers = await fetchWindowBuyers(CHAIN, tokenAddress, tier.windowSeconds);
  // The count came from the same table a moment ago, so a mismatch means a
  // retention sweep or a concurrent delivery moved under us. Firing on a count
  // we cannot substantiate is worse than missing one.
  if (buyers.length < tier.wallets) return null;

  const buyerRoster = await fetchRoster(
    CHAIN,
    buyers.map((b) => b.walletAddress)
  );

  const ordered = [...buyers].sort(
    (a, b) => (buyerRoster.get(b.walletAddress)?.avgMultipleX ?? 0) -
      (buyerRoster.get(a.walletAddress)?.avgMultipleX ?? 0)
  );

  const snapshots: AlertWalletSnapshot[] = ordered.slice(0, MAX_STORED_WALLETS).map((buyer) => {
    const entry = buyerRoster.get(buyer.walletAddress);
    return {
      address: buyer.walletAddress,
      label: entry?.label ?? null,
      twitter: entry?.twitter ?? null,
      multipleX: entry?.avgMultipleX ?? null,
      pnlUsd: entry?.avgPnlUsd ?? null,
      bestMultipleX: entry?.bestMultipleX ?? null,
      bestSymbol: entry?.bestSymbol ?? null,
      boughtUsd: buyer.boughtUsd,
      boughtAt: buyer.firstBuy.toISOString(),
      exited: buyer.exited,
    };
  });

  const firstBuy = Math.min(...buyers.map((b) => b.firstBuy.getTime()));
  const lastBuy = Math.max(...buyers.map((b) => b.firstBuy.getTime()));
  const exitedCount = buyers.filter((b) => b.exited).length;

  const claimed = await claimTier({
    chain: CHAIN,
    tokenAddress,
    tier,
    episode,
    spanSeconds: Math.round((lastBuy - firstBuy) / 1000),
    wallets: snapshots,
    exitedCount,
    avgMultipleX: mean(buyers.map((b) => buyerRoster.get(b.walletAddress)?.avgMultipleX ?? null)),
    avgPnlUsd: mean(buyers.map((b) => buyerRoster.get(b.walletAddress)?.avgPnlUsd ?? null)),
    totalBoughtUsd: buyers.reduce((sum, b) => sum + b.boughtUsd, 0),
  });
  // Already announced for this token and episode. This is the normal path for
  // the second, third and fourth buy inside one window, not an error.
  if (!claimed) return null;

  const snapshot = await fetchAlertTokenSnapshot(tokenAddress);
  await attachTokenSnapshot(claimed.id, snapshot);

  // The band, checked against the cap right now. Outside it the tier stays
  // CLAIMED — so it can never fire later on the same count — but it is marked
  // out of band, which keeps it off Telegram, out of the feed and out of the
  // record. That is what makes the rule work as intended: two wallets in at $5K
  // is skipped, and the third buying at $11K fires with $11K as the entry.
  //
  // A token whose cap could not be read at all is let through: silently
  // dropping calls because an upstream lookup failed would look like a quiet
  // day, and that failure mode has already cost this system once.
  const mcap = snapshot.mcapUsd;
  const outOfBand =
    typeof mcap === "number" && mcap > 0
      ? mcap < MIN_ALERT_MCAP_USD || mcap > MAX_ALERT_MCAP_USD
      : false;

  if (outOfBand) {
    await markOutOfBand(claimed.id, mcap ?? 0);
    return { tokenAddress, tier: tier.wallets, wallets: buyers.length };
  }

  // Most of the window is already out. The owner's rule, 2026-08-22: an alert
  // whose wallets have mostly sold is selling the reader an exit.
  //
  // Suppressed from Telegram only. It keeps its claim, stays on the feed and
  // keeps being tracked, because the evidence so far runs the other way — the
  // steps this removes hit 2x MORE often than the ones where nobody had sold,
  // and BOTFIRM, the call that prompted the rule, peaked at 3.85x. Leaving the
  // suppressed steps in the record is what makes the threshold falsifiable.
  const soldShare = buyers.length > 0 ? exitedCount / buyers.length : 0;
  if (soldShare > MAX_SOLD_SHARE) {
    await markDelivered(claimed.id, `mostly-sold-${Math.round(soldShare * 100)}pct`, null);
    return { tokenAddress, tier: tier.wallets, wallets: buyers.length };
  }

  if (tier.wallets < TELEGRAM_MIN_TIER) {
    await markDelivered(claimed.id, `suppressed-below-tier-${TELEGRAM_MIN_TIER}`, null);
    return { tokenAddress, tier: tier.wallets, wallets: buyers.length };
  }

  if (isTelegramConfigured()) {
    const message = buildAlertMessage({
      tier,
      spanSeconds: Math.round((lastBuy - firstBuy) / 1000),
      chain: CHAIN,
      tokenAddress,
      tokenSymbol: snapshot.symbol,
      tokenName: snapshot.name,
      mcapUsd: snapshot.mcapUsd,
      wallets: snapshots.slice(0, MAX_MESSAGE_WALLETS),
      // Averaged over the WHOLE window, not just the wallets listed. Trimming
      // the list to six must not quietly change the headline statistic.
      avgMultipleX: mean(buyers.map((b) => buyerRoster.get(b.walletAddress)?.avgMultipleX ?? null)),
      avgPnlUsd: mean(buyers.map((b) => buyerRoster.get(b.walletAddress)?.avgPnlUsd ?? null)),
      totalBoughtUsd: buyers.reduce((sum, b) => sum + b.boughtUsd, 0),
      exitedCount,
      walletCount: buyers.length,
    });
    // Thread under the first announced step of this call, if there is one.
    const anchor = await fetchCallAnchorMessageId(CHAIN, tokenAddress, episode);
    const result = await sendAlertMessage(
      message,
      buildAlertButtons(CHAIN, tokenAddress),
      anchor
    );
    await markDelivered(claimed.id, result.ok ? null : result.error, result.messageId);
  }

  return { tokenAddress, tier: tier.wallets, wallets: buyers.length };
}

// --- Raw verification mode ---

/**
 * Forward every classified trade to Telegram, unaggregated.
 *
 * Step 2 of the agreed rollout, and the gate on everything above it: landing
 * the transactions correctly is the hard part, and counting them is easy.
 * Leaving this on in production would be unreadable, so it is opt-in.
 */
export function rawModeEnabled(): boolean {
  return process.env.ALERTS_RAW_MODE === "1" && isTelegramConfigured();
}

/** Bounds the damage if raw mode is left on during a busy period. */
const MAX_RAW_LINES = 10;

async function postRawLines(
  events: ClassifiedEvent[],
  inserted: Array<{ tokenAddress: string; walletAddress: string; side: string }>,
  roster: Map<string, RosterEntry>
): Promise<void> {
  const isNew = new Set(inserted.map((r) => `${r.walletAddress} ${r.tokenAddress} ${r.side}`));
  const fresh = events.filter(
    (e) => isNew.has(`${e.wallet} ${e.mint} ${e.side}`) && e.amountUsd >= MIN_BUY_USD
  );

  for (const event of fresh.slice(0, MAX_RAW_LINES)) {
    await sendPlainMessage(
      buildRawLine({
        wallet: event.wallet,
        label: roster.get(event.wallet)?.label ?? null,
        side: event.side,
        mint: event.mint,
        amountUsd: event.amountUsd,
        signature: event.signature,
      })
    );
  }
  if (fresh.length > MAX_RAW_LINES) {
    await sendPlainMessage(`…and ${fresh.length - MAX_RAW_LINES} more in this batch`);
  }
}
