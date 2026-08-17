import { NextRequest, NextResponse } from "next/server";
import type { Chain } from "@/lib/types";
import { fetchWalletDetail, isSolanaTrackerConfigured } from "@/lib/solanaTracker";
import { fetchEvmWalletDetail, isBirdeyeConfigured, type EvmChain } from "@/lib/birdeye";
import { upstreamMessage, upstreamStatus } from "@/lib/upstream";
import { isChain, isValidAddressForChain } from "@/lib/chains";
import { isOwnerKey } from "@/lib/access";
import { clientIp, rateLimit } from "@/lib/rateLimit";
import { verifyScanSession } from "@/lib/scanSession";

// Each call costs upstream credits, so it is gated on a scan session and capped
// per IP. Wallet clicks are bursty (a buyer opening rows quickly) hence the
// higher allowance than scanning.
const MAX_DETAILS_PER_MINUTE = 40;

export async function GET(request: NextRequest) {
  const limited = rateLimit(`detail:${clientIp(request)}`, MAX_DETAILS_PER_MINUTE, 60_000);
  if (!limited.ok) {
    return NextResponse.json(
      { error: "Too many requests. Slow down." },
      { status: 429, headers: { "Retry-After": String(limited.retryAfterSeconds) } }
    );
  }

  const searchParams = request.nextUrl.searchParams;
  const tokenAddress = searchParams.get("token")?.trim() ?? "";
  const walletAddress = searchParams.get("wallet")?.trim() ?? "";
  const chainParam = searchParams.get("chain") ?? "solana";

  if (!isChain(chainParam)) {
    return NextResponse.json({ error: "Unsupported chain." }, { status: 400 });
  }
  const chain: Chain = chainParam;

  // Passed by the client (already has it from the top-traders load) to avoid
  // burning an extra token-info API call on every wallet click. Clamped because
  // it is attacker-controlled and feeds downstream supply math.
  const supplyParam = Number(searchParams.get("estimatedSupply") ?? "0");
  const estimatedSupply =
    Number.isFinite(supplyParam) && supplyParam > 0 ? Math.min(supplyParam, Number.MAX_SAFE_INTEGER) : 0;

  if (!isValidAddressForChain(chain, tokenAddress) || !isValidAddressForChain(chain, walletAddress)) {
    return NextResponse.json({ error: "Invalid token or wallet address." }, { status: 400 });
  }

  // Detail lookups are only for tokens the caller already paid to scan. The
  // session is an HMAC bound to this exact chain + token, so it can't be reused
  // to mine wallet data for arbitrary tokens.
  const authorized =
    isOwnerKey(request.headers.get("x-owner-key")) ||
    verifyScanSession(request.headers.get("x-scan-session"), chain, tokenAddress);
  if (!authorized) {
    return NextResponse.json(
      { error: "Run a scan for this token first.", reason: "scan_required" },
      { status: 403 }
    );
  }

  const isSolana = chain === "solana";
  if (isSolana ? !isSolanaTrackerConfigured() : !isBirdeyeConfigured()) {
    return NextResponse.json({ error: "not_configured" }, { status: 200 });
  }

  try {
    const detail = isSolana
      ? await fetchWalletDetail(tokenAddress, walletAddress, estimatedSupply)
      : await fetchEvmWalletDetail(chain as EvmChain, tokenAddress, walletAddress, estimatedSupply);
    return NextResponse.json({ ...detail, isDemoData: false });
  } catch (err) {
    return NextResponse.json(
      { error: upstreamMessage(err, "Failed to fetch wallet detail.") },
      { status: upstreamStatus(err) }
    );
  }
}
