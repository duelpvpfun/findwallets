import { NextResponse, type NextRequest } from "next/server";
import { clientIp, rateLimit } from "@/lib/rateLimit";
import { fetchAlertFeed, fetchAlertSummary, fetchTierScoreboard } from "@/lib/db/alerts";
import { alertsArePublic } from "@/lib/alerts/config";
import { isAdminRequest } from "@/lib/adminAuth";

export const dynamic = "force-dynamic";

const MAX_REQUESTS_PER_MINUTE = 60;
const CHAIN = "solana";

/**
 * The alert feed, as JSON.
 *
 * Gated in lockstep with the page: owner-only until `ALERTS_PUBLIC=1`, because
 * a private page served by a public endpoint is a public page with extra steps.
 *
 * Wallet addresses arrive already masked from `fetchAlertFeed`. That masking is
 * a business boundary rather than a display choice — the curated list of proven
 * wallets is what a scan sells, and full addresses here would let anyone rebuild
 * it by polling this URL.
 */
export async function GET(request: NextRequest) {
  // The same gate as the page. A private page served by a public JSON endpoint
  // is a public page with extra steps.
  if (!alertsArePublic() && !(await isAdminRequest())) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }

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
