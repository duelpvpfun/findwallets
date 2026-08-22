import { NextResponse, type NextRequest } from "next/server";
import { clientIp, rateLimit } from "@/lib/rateLimit";
import { fetchAlertFeed, fetchAlertSummary } from "@/lib/db/alerts";
import { alertsArePublic } from "@/lib/alerts/config";
import { isAdminRequest } from "@/lib/adminAuth";

/**
 * NO route-segment cache config here, deliberately.
 *
 * Both `dynamic = "force-dynamic"` and `revalidate = 0` make Next stamp
 * `Cache-Control: no-store` on the response, silently overriding the header set
 * below — and that header is the whole reason this endpoint survives a crowd.
 * The handler reads `request.nextUrl`, so it is dynamic regardless; dropping
 * the flag only changes whether the CDN may hold one copy for everybody.
 *
 * Verified by reading the response header off a production build, because the
 * two disagree quietly rather than loudly, and `next dev` reports `no-store`
 * either way.
 */

const MAX_REQUESTS_PER_MINUTE = 60;
const CHAIN = "solana";

/**
 * How long the CDN may serve one copy of the feed to everybody.
 *
 * **This is the difference between surviving a launch and not.** Every viewer
 * polls this endpoint every few seconds and every one of them gets byte
 * identical data, so without a shared cache 1,000 concurrent readers are 125
 * requests a second, each running a 120ms grouped query against a connection
 * pool of three. A fan-out wider than that pool does not queue — Supabase's
 * transaction pooler stops answering entirely and every request hangs until the
 * platform kills it. Five seconds of shared cache turns those 125 requests a
 * second into one database read every five seconds, whatever the audience.
 *
 * Five seconds because the feed is the live product and a row arriving is the
 * thing people are watching for; `stale-while-revalidate` then means nobody
 * ever waits on the refresh, they just get the previous copy while it happens.
 */
const CDN_MAX_AGE_SECONDS = 5;
const CDN_STALE_SECONDS = 55;

/**
 * Cacheable ONLY when the feed is public.
 *
 * While `ALERTS_PUBLIC` is off this response depends on the /admin cookie, and
 * a shared cache cannot see that difference: one admin request would be stored
 * and then served to everyone, which is how a gated endpoint leaks. So the
 * private path is explicitly `no-store` rather than merely un-cached.
 */
/**
 * A five-second memo, per warm instance.
 *
 * Second layer under the CDN, and it exists because the first layer is somebody
 * else's infrastructure. If an edge cache misses, is bypassed, or is not there
 * at all, every request that reaches a function still costs one 120ms grouped
 * query — and it is precisely under a crowd that a cache is most likely to be
 * cold on some node. This bounds each instance to one database read per window
 * no matter how many requests land on it.
 *
 * Only the un-paged, default-shaped request is memoised: that is the one every
 * viewer polls, and keying on anything more would be a cache with a thousand
 * entries serving one reader each.
 */
let memo: { at: number; limit: number; body: unknown } | null = null;
const MEMO_MS = CDN_MAX_AGE_SECONDS * 1000;

function cacheHeaders(): Record<string, string> {
  if (!alertsArePublic()) return { "Cache-Control": "private, no-store" };
  const shared = `public, s-maxage=${CDN_MAX_AGE_SECONDS}, stale-while-revalidate=${CDN_STALE_SECONDS}`;
  return {
    "Cache-Control": shared,
    // Next stamps `Cache-Control: no-store` on every dynamic route handler and
    // overwrites the line above. These two are not touched, and on Vercel they
    // are what actually controls the edge — `Vercel-CDN-Cache-Control` is
    // stripped before the response reaches the browser.
    "CDN-Cache-Control": shared,
    "Vercel-CDN-Cache-Control": shared,
  };
}

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

  // Resolved once and used as part of the memo key. Keying on `before` alone
  // would let a `?limit=5` caller be served the 60-row payload the pollers put
  // there, which is a wrong answer rather than a slow one.
  const resolvedLimit = Number.isFinite(count) && count > 0 ? Math.min(count, 100) : 40;

  // The shape every viewer polls. Anything else falls through to the database.
  const memoisable = !(before > 0);

  if (memoisable && memo && memo.limit === resolvedLimit && Date.now() - memo.at < MEMO_MS) {
    return NextResponse.json(memo.body, { headers: cacheHeaders() });
  }

  try {
    // Sequential, never Promise.all — see AGENTS.md. Even two statements against
    // a pool of 3 must not be fanned out; that is what stops the pooler
    // answering at all.
    const alerts = await fetchAlertFeed(
      CHAIN,
      resolvedLimit,
      Number.isFinite(before) && before > 0 ? before : undefined
    );

    // Paging requests only want the next page; the header figures do not change
    // as you scroll and re-reading them per page is wasted work.
    // Older pages age out far more slowly than the head of the feed: the rows
    // are fixed and only their peaks move. Same cache, and it means an infinite
    // scroll through a long history costs one read per page per window rather
    // than one per reader.
    if (before > 0) return NextResponse.json({ alerts }, { headers: cacheHeaders() });

    const summary = await fetchAlertSummary(CHAIN);

    // The tier scoreboard is NOT here. It used to be, unread by any caller, on
    // an endpoint that goes public with ALERTS_PUBLIC — which is the same
    // mistake as a private page served by a public route. Hit rates and "what
    // holding paid" are how we decide what to tune; publishing them invites
    // reading an operator's median as a return somebody made. It lives on
    // /admin, which is what the note in feed/page.tsx already claimed.
    const body = { alerts, summary };
    if (memoisable) memo = { at: Date.now(), limit: resolvedLimit, body };
    return NextResponse.json(body, { headers: cacheHeaders() });
  } catch (err) {
    console.error("[alerts/feed] failed:", err);
    // Never cache a failure. A cached empty feed would outlive the outage that
    // caused it and make a healthy service look dead for a full window.
    return NextResponse.json(
      { alerts: [], summary: null },
      { headers: { "Cache-Control": "private, no-store" } }
    );
  }
}
