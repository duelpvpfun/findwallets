import { NextResponse, type NextRequest } from "next/server";
import { clientIp, rateLimit } from "@/lib/rateLimit";
import { recordVisit } from "@/lib/db/visits";

export const dynamic = "force-dynamic";

// A page view fires once per load; this only stops someone looping the beacon to
// pad the numbers (or fill the table).
const MAX_VISITS_PER_MINUTE = 10;

/** Fire-and-forget page-view beacon for the owner dashboard. */
export async function POST(request: NextRequest) {
  const ip = clientIp(request);
  const limited = rateLimit(`visit:${ip}`, MAX_VISITS_PER_MINUTE, 60_000);
  if (!limited.ok) return new NextResponse(null, { status: 204 });

  let path = "/";
  try {
    const body = await request.json();
    if (typeof body?.path === "string" && body.path.startsWith("/")) path = body.path;
  } catch {
    // No body is fine — default to the homepage.
  }

  await recordVisit({
    path,
    // Only the origin, never the full referring URL with its query string.
    referrer: safeOrigin(request.headers.get("referer")),
    country: request.headers.get("x-vercel-ip-country"),
    ip,
    userAgent: request.headers.get("user-agent") ?? "",
  });

  return new NextResponse(null, { status: 204 });
}

function safeOrigin(referer: string | null): string | null {
  if (!referer) return null;
  try {
    return new URL(referer).origin;
  } catch {
    return null;
  }
}
