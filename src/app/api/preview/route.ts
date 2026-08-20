import { NextResponse, type NextRequest } from "next/server";
import { clientIp, rateLimit } from "@/lib/rateLimit";
import { fetchCachedScan, isShowcaseToken } from "@/lib/db/showcase";
import { isValidAddressForChain, isChain } from "@/lib/chains";

export const dynamic = "force-dynamic";

const MAX_REQUESTS_PER_MINUTE = 20;
/** Free samples show a slice, not a full paid scan. */
const PREVIEW_LIMIT = 25;

/**
 * Replays an already-cached scan for a hand-picked token. Serves entirely from
 * our database: no credit is consumed and no paid upstream API is called, so
 * the sample costs nothing regardless of traffic. Only tokens already in the
 * showcase list are allowed — an arbitrary address can't be scanned for free.
 */
export async function GET(request: NextRequest) {
  const limit = await rateLimit(`preview:${clientIp(request)}`, MAX_REQUESTS_PER_MINUTE, 60_000);
  if (!limit.ok) {
    return NextResponse.json(
      { error: "Too many requests. Try again shortly." },
      { status: 429, headers: { "Retry-After": String(limit.retryAfterSeconds) } }
    );
  }

  const { searchParams } = new URL(request.url);
  const chain = searchParams.get("chain") ?? "";
  const address = searchParams.get("address") ?? "";

  if (!isChain(chain)) {
    return NextResponse.json({ error: "Unsupported chain." }, { status: 400 });
  }
  if (!isValidAddressForChain(chain, address)) {
    return NextResponse.json({ error: "Invalid token address." }, { status: 400 });
  }

  try {
    const storedAddress = await isShowcaseToken(chain, address);
    if (!storedAddress) {
      return NextResponse.json(
        { error: "That token isn't available as a free sample. Run a full scan to see it." },
        { status: 404 }
      );
    }

    const cached = await fetchCachedScan(chain, storedAddress, PREVIEW_LIMIT);
    if (!cached) {
      return NextResponse.json({ error: "No cached results for that token." }, { status: 404 });
    }

    return NextResponse.json(
      {
        token: cached.token,
        traders: cached.traders,
        isDemoData: false,
        isPreview: true,
        previewLimit: PREVIEW_LIMIT,
      },
      { headers: { "Cache-Control": "public, s-maxage=600, stale-while-revalidate=1800" } }
    );
  } catch (err) {
    console.error("[preview] failed:", err);
    return NextResponse.json({ error: "Preview unavailable right now." }, { status: 500 });
  }
}
