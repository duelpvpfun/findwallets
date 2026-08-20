import { NextRequest, NextResponse } from "next/server";
import { waitUntil } from "@vercel/functions";
import * as Sentry from "@sentry/nextjs";
import type { Chain } from "@/lib/types";
import { buildTopTraders } from "@/lib/mockData";
import {
  fetchTokenMeta,
  fetchTopTraders,
  fetchWalletLifetimeBatch,
  isSolanaTrackerConfigured,
} from "@/lib/solanaTracker";
import {
  fetchEvmTokenMeta,
  fetchEvmTopTraders,
  fetchEvmWalletLifetime,
  isBirdeyeConfigured,
  type EvmChain,
} from "@/lib/birdeye";
import { upstreamMessage, upstreamStatus } from "@/lib/upstream";
import { isDbConfigured } from "@/lib/db";
import { recordScan, type LifetimeStats } from "@/lib/db/record";
import { fetchWalletHistories } from "@/lib/db/history";
import { filterNeedsEnrichment } from "@/lib/db/enriched";
import { confirmCreditDelivered, releaseCredit } from "@/lib/db/credits";
import { resolveAccess, type AccessResult } from "@/lib/access";
import {
  addressMismatchMessage,
  isChain,
  isValidAddressForChain,
  siblingEvmChain,
  CHAIN_LABELS,
} from "@/lib/chains";
import { clientIp, rateLimit } from "@/lib/rateLimit";
import { issueScanSession } from "@/lib/scanSession";
import { meetsQualityBar } from "@/lib/quality";
import type { ScanEvent, ScanResult, TokenMeta, WalletTrader } from "@/lib/types";

// 300s is the ceiling on Vercel Pro (Hobby caps at 60s regardless of what is
// declared here, and Fluid Compute would allow more).
export const maxDuration = 300;
export const dynamic = "force-dynamic";

// Wall-clock budget for paging upstream. The point is to finish the scan the
// buyer paid for, not to return early: measured against the live providers a Top
// 500 takes seconds, so this only ever bites when a provider is badly degraded.
// It sits far enough below maxDuration to leave room for the work that follows
// paging — on-chain holdings, prior-wins history, and serialising the response —
// because being killed after the credit is spent is the one outcome worse than
// waiting.
const SCAN_BUDGET_MS = 180_000;

// 50 is retired from the pricing table but still accepted, so anyone holding an
// unspent 50-credit from before it was pulled can still redeem it.
const ALLOWED_LIMITS = [50, 100, 250, 500];
// Birdeye has no batch lifetime endpoint, so each EVM wallet costs 35 CU. Cap
// enrichment to the top ranks; the rest still get stored with per-token data.
const EVM_ENRICH_LIMIT = 25;
// Generous for a human (each scan is a paid action) but stops scripted hammering.
const MAX_SCANS_PER_MINUTE = 12;

async function persistScan(token: TokenMeta, traders: WalletTrader[]) {
  if (!isDbConfigured()) return;
  try {
    // The quality bar gates ENRICHMENT, not storage. Every trader row is stored
    // (recordScan flags each one), because dropping the losses is what made win
    // rate uncomputable. Enrichment is where the money goes — Solana Tracker
    // credits and 35 Birdeye CU per wallet — so it stays behind the bar.
    const qualifying = traders.filter((t) => meetsQualityBar(t.avgMultipleX, t.realizedPnlUsd));

    // Wallets enriched recently keep their stored lifetime stats, so repeat
    // scans of overlapping wallet sets cost nothing extra.
    const candidates =
      token.chain === "solana"
        ? qualifying.map((t) => t.address)
        : qualifying.slice(0, EVM_ENRICH_LIMIT).map((t) => t.address);

    let lifetime: LifetimeStats[] = [];
    if (candidates.length > 0) {
      const needsEnrichment = await filterNeedsEnrichment(token.chain, candidates);
      if (needsEnrichment.length > 0) {
        lifetime =
          token.chain === "solana"
            ? await fetchWalletLifetimeBatch(needsEnrichment)
            : await fetchEvmWalletLifetime(token.chain as EvmChain, needsEnrichment);
      }
    }
    await recordScan(token, traders, lifetime);
  } catch (err) {
    console.error("[persistScan] failed:", err);
  }
}

/** The credit was already claimed before the scan ran, so settling means giving
 * it back when no wallets were delivered — an empty result or a failed upstream
 * call must never cost the buyer their purchase. */
async function refundCredit(access: AccessResult, chain: Chain, tokenAddress: string) {
  if (!access.claimToken) return;
  try {
    const released = await releaseCredit(access.claimToken, chain, tokenAddress);
    if (!released) {
      console.warn("[refundCredit] no matching reservation to release", { chain, tokenAddress });
    }
  } catch (err) {
    console.error("[refundCredit] failed to release credit:", err);
  }
}

/** Clears the sweeper's claim once the buyer actually has their wallets. */
async function settleCredit(access: AccessResult) {
  if (!access.claimToken) return;
  try {
    await confirmCreditDelivered(access.claimToken);
  } catch (err) {
    console.error("[settleCredit] failed to confirm delivery:", err);
  }
}

export async function GET(request: NextRequest) {
  const limited = await rateLimit(`scan:${clientIp(request)}`, MAX_SCANS_PER_MINUTE, 60_000);
  if (!limited.ok) {
    return NextResponse.json(
      { error: "Too many scans from this connection. Wait a moment and try again." },
      { status: 429, headers: { "Retry-After": String(limited.retryAfterSeconds) } }
    );
  }

  const searchParams = request.nextUrl.searchParams;
  const address = searchParams.get("address")?.trim() ?? "";
  const limitParam = Number(searchParams.get("limit") ?? "100");
  const chainParam = searchParams.get("chain") ?? "solana";

  // Never silently substitute a chain — that would scan a token the user didn't ask for.
  if (!isChain(chainParam)) {
    return NextResponse.json({ error: "Unsupported chain." }, { status: 400 });
  }
  const chain: Chain = chainParam;

  // Rejecting a wrong-chain address here means a misplaced CA can never reach
  // a paid upstream call, let alone consume the buyer's credit.
  if (!isValidAddressForChain(chain, address)) {
    return NextResponse.json(
      {
        error:
          addressMismatchMessage(chain, address) ??
          `Invalid contract address for ${CHAIN_LABELS[chain]}.`,
      },
      { status: 400 }
    );
  }

  const requestedLimit = ALLOWED_LIMITS.includes(limitParam) ? limitParam : 100;

  // Entitlement is resolved server-side; the client can ask for 500 but only
  // receives what its credit (or owner key) allows. The claim token travels in a
  // header so it stays out of access logs, proxies and Referer headers.
  const access = await resolveAccess(
    request.headers.get("x-owner-key"),
    request.headers.get("x-claim-token"),
    chain,
    address
  );
  if (!access.allowed) {
    return NextResponse.json(
      {
        error:
          access.reason === "credit_used"
            ? "This purchase has already been used for a scan."
            : access.reason === "credit_pending"
            ? "A scan for this purchase is still running. Your purchase has not been spent — wait a few seconds and try again."
            : access.reason === "credit_invalid"
            ? "Invalid or unknown purchase token."
            : "Payment required to scan.",
        reason: access.reason,
      },
      { status: 402 }
    );
  }
  const limit = Math.min(requestedLimit, access.maxLimit);

  const isSolana = chain === "solana";

  // No API key configured: serve deterministic mock data so the UI is still
  // usable, but flag it clearly so it's never mistaken for real data.
  if (isSolana ? !isSolanaTrackerConfigured() : !isBirdeyeConfigured()) {
    return NextResponse.json({ ...buildTopTraders(address, limit, chain), isDemoData: true });
  }

  const deadlineAt = Date.now() + SCAN_BUDGET_MS;

  // Opt-in NDJSON: progress lines while paging, then one final result line.
  // Turns a 30s blank spinner into a live count without changing the payload.
  const wantsStream = searchParams.get("stream") === "1";
  let emit: ((event: ScanEvent) => void) | undefined;
  let closeStream: (() => void) | undefined;
  let body: ReadableStream<Uint8Array> | undefined;

  if (wantsStream) {
    const encoder = new TextEncoder();
    body = new ReadableStream({
      start(controller) {
        emit = (event) => {
          try {
            controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
          } catch {
            // Client disconnected; the scan itself still completes and persists.
          }
        };
        closeStream = () => {
          try {
            controller.close();
          } catch {
            // already closed
          }
        };
      },
    });
  }

  const run = async () => {
  try {
    const token = isSolana
      ? await fetchTokenMeta(address)
      : await fetchEvmTokenMeta(chain as EvmChain, address);
    emit?.({ type: "token", token });

    let found = 0;
    const onProgress = emit
      ? (page: WalletTrader[]) => {
          found += page.length;
          emit?.({ type: "progress", found, requested: limit });
        }
      : undefined;

    const traders = isSolana
      ? await fetchTopTraders(address, limit, token.estimatedSupply, deadlineAt, onProgress)
      : await fetchEvmTopTraders(
          chain as EvmChain,
          address,
          limit,
          token.estimatedSupply,
          "90d",
          token.priceUsd,
          deadlineAt,
          onProgress
        );

    if (traders.length === 0) {
      await refundCredit(access, chain, address);
    } else {
      await settleCredit(access);
    }

    // Read prior wins before persisting, so this scan doesn't show up as its own history.
    const histories = await fetchWalletHistories(chain, address, traders.map((t) => t.address));
    // Enrichment is a side effect the buyer is not waiting for. Keeping it on
    // the critical path let upstream latency delay — or kill — the response
    // they already paid for.
    waitUntil(persistScan(token, traders));

    // An EVM address is valid on every EVM chain, so a token pasted under the
    // wrong one looks like an empty result. Say so instead of leaving the buyer
    // thinking they paid for nothing — the credit is untouched at zero traders.
    const sibling = siblingEvmChain(chain);
    const note =
      traders.length === 0 && sibling
        ? `No traders found on ${CHAIN_LABELS[chain]}. If this token is on ${CHAIN_LABELS[sibling]}, switch chains and search again — you have not been charged for this scan.`
        : undefined;

    // Upstream simply may not have `limit` qualifying traders, so a short result
    // is only "partial" when the clock is what stopped us.
    const partial = traders.length < limit && Date.now() >= deadlineAt;

    // A paid scan that under-delivered is the failure mode worth querying on.
    if (partial || traders.length === 0) {
      Sentry.captureMessage(
        traders.length === 0 ? "scan delivered no traders" : "scan delivered a partial result",
        {
          level: "warning",
          tags: {
            chain,
            tier: limit,
            deliveredCount: traders.length,
            paid: Boolean(access.claimToken),
          },
        }
      );
    }

    const payload: ScanResult = {
      token,
      traders,
      histories,
      isDemoData: false,
      note,
      partial,
      deliveredCount: traders.length,
      requestedCount: limit,
      scanSession: traders.length > 0 ? issueScanSession(chain, address) : undefined,
    };

    if (emit) {
      emit({ type: "result", result: payload });
      return null;
    }
    return NextResponse.json(payload);
  } catch (err) {
    await refundCredit(access, chain, address);
    console.error("[top-traders] upstream failed:", err);
    Sentry.captureException(err, {
      tags: { chain, tier: limit, deliveredCount: 0, paid: Boolean(access.claimToken) },
    });
    if (emit) {
      emit({ type: "error", error: upstreamMessage(err) });
      return null;
    }
    return NextResponse.json({ error: upstreamMessage(err) }, { status: upstreamStatus(err) });
  }
  };

  if (!body) return (await run()) as NextResponse;

  // The stream is the response; the scan continues writing into it after this
  // function returns.
  void run().finally(() => closeStream?.());
  return new NextResponse(body, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store",
      // Proxies that buffer would defeat the point of streaming.
      "X-Accel-Buffering": "no",
    },
  });
}
