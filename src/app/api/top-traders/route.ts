import { NextRequest, NextResponse } from "next/server";
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
import { releaseCredit } from "@/lib/db/credits";
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
import type { TokenMeta, WalletTrader } from "@/lib/types";

// 50 is retired from the pricing table but still accepted, so anyone holding an
// unspent 50-credit from before it was pulled can still redeem it.
const ALLOWED_LIMITS = [50, 100, 250, 500];
// Birdeye has no batch lifetime endpoint, so each EVM wallet costs 35 CU. Cap
// enrichment to the top ranks; the rest still get stored with per-token data.
const EVM_ENRICH_LIMIT = 25;
// Generous for a human (each scan is a paid action) but stops scripted hammering.
const MAX_SCANS_PER_MINUTE = 12;

// Wallets below this multiple aren't worth surfacing to customers, so they
// never get written to the DB in the first place — keeps the table from
// filling up with irrelevant/low-performing wallets on every scan.
const MIN_MULTIPLE_X_TO_STORE = 2;

async function persistScan(token: TokenMeta, traders: WalletTrader[]) {
  if (!isDbConfigured()) return;
  try {
    const qualifying = traders.filter((t) => t.avgMultipleX >= MIN_MULTIPLE_X_TO_STORE);
    if (qualifying.length === 0) return;

    // Wallets enriched recently keep their stored lifetime stats, so repeat
    // scans of overlapping wallet sets cost nothing extra.
    const candidates =
      token.chain === "solana"
        ? qualifying.map((t) => t.address)
        : qualifying.slice(0, EVM_ENRICH_LIMIT).map((t) => t.address);
    const needsEnrichment = await filterNeedsEnrichment(token.chain, candidates);

    let lifetime: LifetimeStats[] = [];
    if (needsEnrichment.length > 0) {
      lifetime =
        token.chain === "solana"
          ? await fetchWalletLifetimeBatch(needsEnrichment)
          : await fetchEvmWalletLifetime(token.chain as EvmChain, needsEnrichment);
    }
    await recordScan(token, qualifying, lifetime);
  } catch (err) {
    console.error("[persistScan] failed:", err);
  }
}

/** The credit was already claimed before the scan ran, so settling means giving
 * it back when no wallets were delivered — an empty result or a failed upstream
 * call must never cost the buyer their purchase. */
async function refundCredit(access: AccessResult) {
  if (!access.claimToken) return;
  try {
    await releaseCredit(access.claimToken);
  } catch (err) {
    console.error("[refundCredit] failed to release credit:", err);
  }
}

export async function GET(request: NextRequest) {
  const limited = rateLimit(`scan:${clientIp(request)}`, MAX_SCANS_PER_MINUTE, 60_000);
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

  try {
    const token = isSolana
      ? await fetchTokenMeta(address)
      : await fetchEvmTokenMeta(chain as EvmChain, address);
    const traders = isSolana
      ? await fetchTopTraders(address, limit, token.estimatedSupply)
      : await fetchEvmTopTraders(
          chain as EvmChain,
          address,
          limit,
          token.estimatedSupply,
          "90d",
          token.priceUsd
        );

    if (traders.length === 0) await refundCredit(access);

    // Read prior wins before persisting, so this scan doesn't show up as its own history.
    const histories = await fetchWalletHistories(chain, address, traders.map((t) => t.address));
    await persistScan(token, traders);

    // An EVM address is valid on every EVM chain, so a token pasted under the
    // wrong one looks like an empty result. Say so instead of leaving the buyer
    // thinking they paid for nothing — the credit is untouched at zero traders.
    const sibling = siblingEvmChain(chain);
    const note =
      traders.length === 0 && sibling
        ? `No traders found on ${CHAIN_LABELS[chain]}. If this token is on ${CHAIN_LABELS[sibling]}, switch chains and search again — you have not been charged for this scan.`
        : undefined;

    return NextResponse.json({
      token,
      traders,
      histories,
      isDemoData: false,
      note,
      scanSession: traders.length > 0 ? issueScanSession(chain, address) : undefined,
    });
  } catch (err) {
    await refundCredit(access);
    return NextResponse.json({ error: upstreamMessage(err) }, { status: upstreamStatus(err) });
  }
}
