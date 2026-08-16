import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { createCredit, tierForPaylink } from "@/lib/db/credits";
import { isDbConfigured } from "@/lib/db";

/**
 * Receives payment confirmations from Helio server-to-server. This must never
 * trust the browser: a client-side onSuccess callback can be forged from
 * devtools, so credits are only minted here after the shared secret matches.
 */
function matches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function isAuthorized(request: NextRequest): boolean {
  // Helio issues a separate shared token per webhook, so accept a comma-separated list.
  const expected = (process.env.HELIO_WEBHOOK_SECRET ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (expected.length === 0) return false;
  const provided =
    request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ??
    request.headers.get("x-helio-signature") ??
    "";
  if (!provided) return false;
  return expected.some((secret) => matches(provided, secret));
}

export async function POST(request: NextRequest) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!isDbConfigured()) {
    return NextResponse.json({ error: "Database not configured" }, { status: 503 });
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const data = (body.data ?? body) as Record<string, unknown>;
  const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);

  // The query param is a fallback for Helio payloads that omit the paylink id.
  const paylinkId =
    str(data.paylinkId) ??
    str(data.paymentRequestId) ??
    str(body.paylinkId) ??
    request.nextUrl.searchParams.get("paylink") ??
    undefined;
  const paymentId =
    str(data.transactionSignature) ?? str(data.id) ?? str(data.transaction) ?? str(body.id);

  if (!paylinkId || !paymentId) {
    return NextResponse.json({ error: "Missing paylinkId or payment id" }, { status: 400 });
  }

  const tier = tierForPaylink(paylinkId);
  if (!tier) {
    return NextResponse.json({ error: "Unknown paylink" }, { status: 400 });
  }

  const claimToken = await createCredit({
    paymentId,
    paylinkId,
    tier,
    email: str(data.email) ?? null,
    payerWallet: str(data.senderPK) ?? str(data.sender) ?? null,
  });

  return NextResponse.json({ ok: true, claimToken, tier });
}
