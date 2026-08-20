import { NextResponse, type NextRequest } from "next/server";
import { clientIp, rateLimit } from "@/lib/rateLimit";
import { fetchShowcaseStats, fetchShowcaseTokens, fetchTickerWallets } from "@/lib/db/showcase";

export const dynamic = "force-dynamic";

const MAX_REQUESTS_PER_MINUTE = 30;
const TICKER_SIZE = 60;

/**
 * Public marketing data: anonymised-by-truncation wallet stats for the homepage
 * ticker plus the list of tokens available as a free sample. Deliberately does
 * not expose a full ranked scan — that stays behind the paywall.
 */
export async function GET(request: NextRequest) {
  const limit = await rateLimit(`showcase:${clientIp(request)}`, MAX_REQUESTS_PER_MINUTE, 60_000);
  if (!limit.ok) {
    return NextResponse.json(
      { error: "Too many requests." },
      { status: 429, headers: { "Retry-After": String(limit.retryAfterSeconds) } }
    );
  }

  try {
    const [walletsList, tokensList, stats] = await Promise.all([
      fetchTickerWallets(TICKER_SIZE),
      fetchShowcaseTokens(),
      fetchShowcaseStats(),
    ]);

    return NextResponse.json(
      { wallets: walletsList, tokens: tokensList, stats },
      { headers: { "Cache-Control": "public, s-maxage=300, stale-while-revalidate=600" } }
    );
  } catch (err) {
    console.error("[showcase] failed:", err);
    return NextResponse.json({ wallets: [], tokens: [], stats: null });
  }
}
