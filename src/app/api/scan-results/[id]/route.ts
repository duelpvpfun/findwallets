import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth/session";
import { fetchScanResultPayload, setScanResultPinned } from "@/lib/db/scanResults";
import { issueScanSession } from "@/lib/scanSession";
import { isChain } from "@/lib/chains";
import { clientIp, rateLimit } from "@/lib/rateLimit";

export const dynamic = "force-dynamic";

const MAX_REQUESTS_PER_MINUTE = 30;

/**
 * Re-delivers a stored scan.
 *
 * Reads the payload out of `scan_results` and NEVER re-runs the scan: nobody's
 * upstream API quota should be spent twice for one purchase. That is the whole
 * point of storing it.
 *
 * Authorization is the `user_id` predicate inside `fetchScanResultPayload` — the
 * id is a sequential integer, so without it any signed-in user could walk
 * everyone else's paid results.
 */
export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const limited = await rateLimit(
    `scan-result:${clientIp(request)}`,
    MAX_REQUESTS_PER_MINUTE,
    60_000
  );
  if (!limited.ok) {
    return NextResponse.json(
      { error: "Too many requests." },
      { status: 429, headers: { "Retry-After": String(limited.retryAfterSeconds) } }
    );
  }

  const session = await getSessionUser();
  if (!session) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

  const { id: rawId } = await context.params;
  const id = Number(rawId);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }

  try {
    const stored = await fetchScanResultPayload(session.id, id);
    // 404 rather than 403 for someone else's result: confirming that an id
    // exists but isn't yours is information with no legitimate use.
    if (!stored) {
      return NextResponse.json(
        { error: "That result has expired or doesn't exist." },
        { status: 404 }
      );
    }

    const payload = stored.payload;
    // The scan session is a short-lived credential and is deliberately not
    // persisted, so it is re-issued here rather than restored.
    const chain = payload.token?.chain;
    const scanSession =
      chain && isChain(chain) && payload.token?.address
        ? issueScanSession(chain, payload.token.address)
        : undefined;

    return NextResponse.json(
      {
        ...payload,
        scanSession,
        expiresAt: stored.expiresAt.toISOString(),
        pinned: stored.pinned,
        fromStoredResult: true,
      },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (err) {
    console.error("[scan-results] read failed:", err);
    return NextResponse.json({ error: "Could not load that result." }, { status: 500 });
  }
}

/** Pins or unpins a result, so it survives the 7-day purge. */
export async function PATCH(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const limited = await rateLimit(
    `scan-result-pin:${clientIp(request)}`,
    MAX_REQUESTS_PER_MINUTE,
    60_000
  );
  if (!limited.ok) {
    return NextResponse.json(
      { error: "Too many requests." },
      { status: 429, headers: { "Retry-After": String(limited.retryAfterSeconds) } }
    );
  }

  const session = await getSessionUser();
  if (!session) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

  const { id: rawId } = await context.params;
  const id = Number(rawId);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (typeof body.pinned !== "boolean") {
    return NextResponse.json({ error: "Expected { pinned: boolean }." }, { status: 400 });
  }

  try {
    const outcome = await setScanResultPinned(session.id, id, body.pinned);
    if (outcome === "not_found") {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }
    if (outcome === "limit_reached") {
      return NextResponse.json(
        { error: "You can keep two results indefinitely. Unpin one first." },
        { status: 409 }
      );
    }
    return NextResponse.json({ outcome });
  } catch (err) {
    console.error("[scan-results] pin failed:", err);
    return NextResponse.json({ error: "Could not update that result." }, { status: 500 });
  }
}
