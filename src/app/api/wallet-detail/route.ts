import { NextRequest, NextResponse } from "next/server";
import type { Chain } from "@/lib/types";
import { fetchWalletDetail, isSolanaTrackerConfigured, SolanaTrackerError } from "@/lib/solanaTracker";
import { BirdeyeError, fetchEvmWalletDetail, isBirdeyeConfigured, type EvmChain } from "@/lib/birdeye";

const SOLANA_ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const EVM_ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;
const ALLOWED_CHAINS: Chain[] = ["solana", "bsc", "base"];

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const tokenAddress = searchParams.get("token")?.trim() ?? "";
  const walletAddress = searchParams.get("wallet")?.trim() ?? "";
  const chainParam = searchParams.get("chain") ?? "solana";
  const chain: Chain = ALLOWED_CHAINS.includes(chainParam as Chain) ? (chainParam as Chain) : "solana";
  // Passed by the client (already has it from the top-traders load) to avoid
  // burning an extra token-info API call on every wallet click.
  const estimatedSupply = Number(searchParams.get("estimatedSupply") ?? "0");

  const addressRe = chain === "solana" ? SOLANA_ADDRESS_RE : EVM_ADDRESS_RE;
  if (!addressRe.test(tokenAddress) || !addressRe.test(walletAddress)) {
    return NextResponse.json({ error: "Invalid token or wallet address." }, { status: 400 });
  }

  if (chain === "solana") {
    if (!isSolanaTrackerConfigured()) {
      return NextResponse.json({ error: "not_configured" }, { status: 200 });
    }
    try {
      const detail = await fetchWalletDetail(tokenAddress, walletAddress, estimatedSupply);
      return NextResponse.json({ ...detail, isDemoData: false });
    } catch (err) {
      const message = err instanceof SolanaTrackerError ? err.message : "Failed to fetch wallet detail.";
      const status = err instanceof SolanaTrackerError && err.status ? err.status : 502;
      return NextResponse.json({ error: message }, { status });
    }
  }

  if (!isBirdeyeConfigured()) {
    return NextResponse.json({ error: "not_configured" }, { status: 200 });
  }
  try {
    const detail = await fetchEvmWalletDetail(chain as EvmChain, tokenAddress, walletAddress, estimatedSupply);
    return NextResponse.json({ ...detail, isDemoData: false });
  } catch (err) {
    const message = err instanceof BirdeyeError ? err.message : "Failed to fetch wallet detail.";
    const status = err instanceof BirdeyeError && err.status ? err.status : 502;
    return NextResponse.json({ error: message }, { status });
  }
}
