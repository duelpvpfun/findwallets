import { NextRequest, NextResponse } from "next/server";
import { fetchWalletDetail, isSolanaTrackerConfigured, SolanaTrackerError } from "@/lib/solanaTracker";

const SOLANA_ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const tokenAddress = searchParams.get("token")?.trim() ?? "";
  const walletAddress = searchParams.get("wallet")?.trim() ?? "";
  // Passed by the client (already has it from the top-traders load) to avoid
  // burning an extra token-info API call on every wallet click.
  const estimatedSupply = Number(searchParams.get("estimatedSupply") ?? "0");

  if (!SOLANA_ADDRESS_RE.test(tokenAddress) || !SOLANA_ADDRESS_RE.test(walletAddress)) {
    return NextResponse.json({ error: "Invalid token or wallet address." }, { status: 400 });
  }

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
