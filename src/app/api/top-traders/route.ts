import { NextRequest, NextResponse } from "next/server";
import { buildTopTraders } from "@/lib/mockData";
import {
  fetchTokenMeta,
  fetchTopTraders,
  isSolanaTrackerConfigured,
  SolanaTrackerError,
} from "@/lib/solanaTracker";

const SOLANA_ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const ALLOWED_LIMITS = [100, 150, 250, 500];

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const address = searchParams.get("address")?.trim() ?? "";
  const limitParam = Number(searchParams.get("limit") ?? "100");

  if (!SOLANA_ADDRESS_RE.test(address)) {
    return NextResponse.json(
      { error: "Invalid Solana contract address." },
      { status: 400 }
    );
  }

  const limit = ALLOWED_LIMITS.includes(limitParam) ? limitParam : 100;

  if (!isSolanaTrackerConfigured()) {
    // No API key configured: serve deterministic mock data so the UI is still
    // usable, but flag it clearly so it's never mistaken for real data.
    const data = buildTopTraders(address, limit);
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
