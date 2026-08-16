import { NextRequest, NextResponse } from "next/server";
import type { Chain } from "@/lib/types";
import { buildTopTraders } from "@/lib/mockData";
import {
  fetchTokenMeta,
  fetchTopTraders,
  isSolanaTrackerConfigured,
  SolanaTrackerError,
} from "@/lib/solanaTracker";
import {
  BirdeyeError,
  fetchEvmTokenMeta,
  fetchEvmTopTraders,
  isBirdeyeConfigured,
  type EvmChain,
} from "@/lib/birdeye";

const SOLANA_ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const EVM_ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;
const ALLOWED_LIMITS = [100, 150, 250, 500];
const ALLOWED_CHAINS: Chain[] = ["solana", "bsc", "base"];

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const address = searchParams.get("address")?.trim() ?? "";
  const limitParam = Number(searchParams.get("limit") ?? "100");
  const chainParam = searchParams.get("chain") ?? "solana";
  const chain: Chain = ALLOWED_CHAINS.includes(chainParam as Chain) ? (chainParam as Chain) : "solana";

  const addressRe = chain === "solana" ? SOLANA_ADDRESS_RE : EVM_ADDRESS_RE;
  if (!addressRe.test(address)) {
    return NextResponse.json(
      { error: `Invalid contract address for ${chain}.` },
      { status: 400 }
    );
  }

  const limit = ALLOWED_LIMITS.includes(limitParam) ? limitParam : 100;

  if (chain === "solana") {
    if (!isSolanaTrackerConfigured()) {
      // No API key configured: serve deterministic mock data so the UI is still
      // usable, but flag it clearly so it's never mistaken for real data.
      const data = buildTopTraders(address, limit, chain);
      return NextResponse.json({ ...data, isDemoData: true });
    }
    try {
      const token = await fetchTokenMeta(address);
      const traders = await fetchTopTraders(address, limit, token.estimatedSupply);
      return NextResponse.json({ token, traders, isDemoData: false });
    } catch (err) {
      const message = err instanceof SolanaTrackerError ? err.message : "Failed to fetch trader data.";
      const status = err instanceof SolanaTrackerError && err.status ? err.status : 502;
      return NextResponse.json({ error: message }, { status });
    }
  }

  // BSC / Base via Birdeye.
  if (!isBirdeyeConfigured()) {
    const data = buildTopTraders(address, limit, chain);
    return NextResponse.json({ ...data, isDemoData: true });
  }
  try {
    const token = await fetchEvmTokenMeta(chain as EvmChain, address);
    const traders = await fetchEvmTopTraders(chain as EvmChain, address, limit, token.estimatedSupply);
    return NextResponse.json({ token, traders, isDemoData: false });
  } catch (err) {
    const message = err instanceof BirdeyeError ? err.message : "Failed to fetch trader data.";
    const status = err instanceof BirdeyeError && err.status ? err.status : 502;
    return NextResponse.json({ error: message }, { status });
  }
}
