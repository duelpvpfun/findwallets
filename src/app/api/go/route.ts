import { NextResponse, after, type NextRequest } from "next/server";
import {
  CHART_VENUE,
  CLICK_SOURCES,
  TRADE_LINKS,
  dexScreenerUrl,
  type ClickSource,
} from "@/lib/alerts/config";
import { clientIp, rateLimit } from "@/lib/rateLimit";
import { recordLinkClick } from "@/lib/db/linkClicks";
import { SITE_URL } from "@/lib/siteUrl";
import type { Chain } from "@/lib/types";

export const dynamic = "force-dynamic";

const CHAINS: Chain[] = ["solana", "bsc", "base"];

/** A reader tapping through three venues on one call is normal. Fifty taps a
 * minute from one address is somebody padding the numbers, and the only thing
 * that changes for them is that the click stops being recorded. */
const MAX_CLICKS_PER_MINUTE = 40;

/**
 * The outbound hop for every buy link, from the channel and from the site.
 *
 * It exists to answer one question the owner cannot answer from a venue's
 * referral dashboard: how much traffic these alerts actually drive, split by
 * where the tap came from. A referral dashboard only ever shows the clicks that
 * converted on that one venue.
 *
 * **The destination is rebuilt here, never passed in.** The request carries a
 * venue slug, a chain and a token address; the URL is composed from
 * `TRADE_LINKS`. That is what keeps this from being an open redirect, and it is
 * not negotiable — a redirector that forwards to a caller-supplied URL is a
 * phishing tool wearing our domain.
 *
 * **The redirect never waits on the write.** `after()` runs the insert once the
 * response is out, so a slow or unreachable database costs a data point and not
 * a buyer. Anything unrecognisable still lands somewhere sensible rather than on
 * an error page: a reader who taps a button has earned a destination.
 */
export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const venue = (params.get("v") ?? "").slice(0, 24);
  const chain = params.get("c") ?? "";
  const address = (params.get("t") ?? "").slice(0, 64);
  const source = params.get("s") ?? "";

  if (!isChain(chain) || !isPlausibleAddress(chain, address)) {
    // Nothing here is worth an error page. Send them to the site and record
    // nothing — a malformed hop is not a click on anything.
    return redirect(new URL("/", SITE_URL).toString());
  }

  const destination = resolveDestination(venue, chain, address);
  if (!destination) return redirect(new URL("/", SITE_URL).toString());

  const ip = clientIp(request);
  const limited = await rateLimit(`go:${ip}`, MAX_CLICKS_PER_MINUTE, 60_000);

  if (limited.ok) {
    const userAgent = request.headers.get("user-agent") ?? "";
    const country = request.headers.get("x-vercel-ip-country");
    after(() =>
      recordLinkClick({
        source: isSource(source) ? source : "site",
        venue,
        chain,
        tokenAddress: address,
        ip,
        userAgent,
        country,
      })
    );
  }

  return redirect(destination);
}

/**
 * 302 and explicitly uncached at every layer.
 *
 * A cached redirect is a click that never reaches this function, and the whole
 * point of the hop is that every tap is counted. `CDN-Cache-Control` is here
 * because Vercel's edge reads it in preference to `Cache-Control`.
 */
function redirect(url: string): NextResponse {
  return new NextResponse(null, {
    status: 302,
    headers: {
      Location: url,
      "Cache-Control": "no-store",
      "CDN-Cache-Control": "no-store",
      "Vercel-CDN-Cache-Control": "no-store",
      // A crawler following one of these adds a click nobody made.
      "X-Robots-Tag": "noindex, nofollow",
    },
  });
}

/**
 * The venue's URL for this token, with our referral code when we have one.
 *
 * This is the half that cannot happen in the browser: referral codes are private
 * env vars, so the feed's buttons have always rendered the plain link and earned
 * nothing. A missing code still falls back to the plain link — an unset env var
 * should cost commission, never dead-end a buyer.
 */
function resolveDestination(venue: string, chain: Chain, address: string): string | null {
  if (venue === CHART_VENUE) return dexScreenerUrl(chain, address);

  const link = TRADE_LINKS.find((l) => l.slug === venue && l.chains.includes(chain));
  if (!link) return null;

  const ref = link.refEnv ? process.env[link.refEnv] : undefined;
  return ref && link.withRef
    ? link.withRef(chain, address, ref)
    : link.plain(chain, address);
}

function isChain(value: string): value is Chain {
  return (CHAINS as string[]).includes(value);
}

function isSource(value: string): value is ClickSource {
  return (CLICK_SOURCES as readonly string[]).includes(value);
}

/**
 * Shape check only, and that is enough.
 *
 * The address is not looked up: an alert can fire on a token no scan has ever
 * touched, and refusing to forward one of those would break the newest calls
 * first. What matters is that nothing but a plausible address can reach a
 * venue URL, so a crafted parameter cannot smuggle a path or a query into it.
 */
function isPlausibleAddress(chain: Chain, address: string): boolean {
  if (chain === "solana") return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address);
  return /^0x[0-9a-fA-F]{40}$/.test(address);
}
