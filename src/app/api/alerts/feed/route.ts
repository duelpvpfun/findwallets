import { NextResponse, type NextRequest } from "next/server";
import { clientIp, rateLimit } from "@/lib/rateLimit";
import { fetchAlertFeed, fetchAlertSummary, fetchTierScoreboard } from "@/lib/db/alerts";

export const dynamic = "force-dynamic";

const MAX_REQUESTS_PER_MINUTE = 60;
const CHAIN = "solana";

/**
 * The public alert feed. Free and unauthenticated on purpose: it is the
 * top-of-funnel for the paid scanner and for the Telegram channel, and it costs
 * nothing per viewer beyond an indexed read.
 *
 * It exposes full wallet addresses, unlike `/api/showcase`, which masks them.
 * That is deliberate and not a leak of the paid product: the paid product is a
 * token's complete ranked trader list with entry and exit prices. Here a reader
 * gets a handful of addresses attached to one alert, with no ranking, no
 * prices, and no way to ask for another token — the same thing they would see
 * in the free Telegram channel.
 */
export async function GET(request: NextRequest) {
  const limit = await rateLimit(`alerts:${clientIp(request)}`, MAX_REQUESTS_PER_MINUTE, 60_000);
  if (!limit.ok) {
    return NextResponse.json(
      { error: "Too many requests." },
      { status: 429, headers: { "Retry-After": String(limit.retryAfterSeconds) } }
    );
  }

  const params = request.nextUrl.searchParams;
  const before = Number(params.get("before"));
  const count = Number(params.get("limit"));

  try {
    // Sequential, never Promise.all — see AGENTS.md. Three statements against a
    // pool of 3 is exactly the fan-out that stops the pooler answering.
    const alerts = await fetchAlertFeed(
      CHAIN,
      Number.isFinite(count) && count > 0 ? Math.min(count, 100) : 40,
      Number.isFinite(before) && before > 0 ? before : undefined
    );

    // Paging requests only want the next page; the header figures do not change
    // as you scroll and re-reading them per page is wasted work.
    if (before > 0) return NextResponse.json({ alerts });

    const summary = await fetchAlertSummary(CHAIN);
    const scoreboard = await fetchTierScoreboard(CHAIN);

    return NextResponse.json({ alerts, summary, scoreboard });
  } catch (err) {
    console.error("[alerts/feed] failed:", err);
    return NextResponse.json({ alerts: [], summary: null, scoreboard: [] });
  }
}
