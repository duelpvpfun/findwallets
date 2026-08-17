import { NextRequest, NextResponse } from "next/server";
import { createHash, timingSafeEqual } from "node:crypto";
import { createCredit, hashNonce, logWebhook, tierForPaylink } from "@/lib/db/credits";
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

function configuredSecrets(): string[] {
  // Helio issues a separate shared token per webhook, so accept a comma-separated list.
  return (process.env.HELIO_WEBHOOK_SECRET ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function providedSecret(request: NextRequest): string {
  return (
    request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ??
    request.headers.get("x-helio-signature") ??
    ""
  );
}

/** Short digest so tokens can be compared in logs without ever storing them. */
function fingerprint(value: string): string {
  return value ? createHash("sha256").update(value).digest("hex").slice(0, 8) : "none";
}

function isAuthorized(request: NextRequest): boolean {
  const expected = configuredSecrets();
  if (expected.length === 0) return false;
  const provided = providedSecret(request);
  if (!provided) return false;
  return expected.some((secret) => matches(provided, secret));
}

export async function POST(request: NextRequest) {
  const raw = await request.text();

  // Recorded before authorization so a rejected delivery still leaves evidence;
  // only a prefix of the credential is kept.
  const trace = async (outcome: string) => {
    const provided = providedSecret(request);
    const sent = fingerprint(provided);
    const known = configuredSecrets().map(fingerprint).join(" ");
    await logWebhook({
      outcome,
      authHeader: `sent=${sent} len=${provided.length} | configured=[${known}]`,
      headerNames: [...request.headers.keys()].join(","),
      query: request.nextUrl.search,
      body: raw.slice(0, 4000),
    });
  };

  if (!isAuthorized(request)) {
    console.error("[helio-webhook] rejected: secret mismatch");
    await trace("unauthorized");
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!isDbConfigured()) {
    console.error("[helio-webhook] rejected: database not configured");
    return NextResponse.json({ error: "Database not configured" }, { status: 503 });
  }

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    await trace("invalid_json");
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);
  const obj = (v: unknown): Record<string, unknown> =>
    typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};

  // Helio wraps everything in `transactionObject`; the other shapes are older
  // variants kept so a format change does not silently drop a payment.
  const data = obj(body.transactionObject ?? body.data ?? body);
  const meta = obj(data.meta);
  const customer = obj(meta.customerDetails);

  // A pending or failed transaction must never mint a credit.
  const status = str(meta.transactionStatus) ?? str(data.transactionStatus);
  if (status && status.toUpperCase() !== "SUCCESS") {
    console.error("[helio-webhook] ignored: transaction not successful", { status });
    await trace(`ignored_status_${status.toLowerCase()}`);
    return NextResponse.json({ ok: false, ignored: status });
  }

  // The query param is a fallback for Helio payloads that omit the paylink id.
  const paylinkId =
    str(data.paylinkId) ??
    str(data.paymentRequestId) ??
    str(body.paylinkId) ??
    request.nextUrl.searchParams.get("paylink") ??
    undefined;
  const paymentId =
    str(meta.transactionSignature) ?? str(data.transactionSignature) ?? str(data.id) ?? str(body.id);

  if (!paylinkId || !paymentId) {
    console.error("[helio-webhook] rejected: missing ids", {
      paylinkId: paylinkId ?? null,
      hasPaymentId: Boolean(paymentId),
      keys: Object.keys(data),
    });
    await trace("missing_ids");
    return NextResponse.json({ error: "Missing paylinkId or payment id" }, { status: 400 });
  }

  const tier = tierForPaylink(paylinkId);
  if (!tier) {
    console.error("[helio-webhook] rejected: unknown paylink", { paylinkId });
    await trace("unknown_paylink");
    return NextResponse.json({ error: "Unknown paylink" }, { status: 400 });
  }

  // The buyer's browser passes a nonce through Helio's additionalJSON; storing
  // it hashed is what stops anyone else redeeming a payment they merely observed.
  const additional = parseAdditional(
    customer.additionalJSON ?? data.additionalJSON ?? body.additionalJSON
  );
  const nonce = str(additional?.nonce);

  const claimToken = await createCredit({
    paymentId,
    paylinkId,
    tier,
    nonceHash: nonce ? hashNonce(nonce) : null,
    email: str(customer.email) ?? str(data.email) ?? null,
    payerWallet: str(meta.senderPK) ?? str(data.senderPK) ?? str(data.sender) ?? null,
  });

  console.log("[helio-webhook] credit created", { paylinkId, tier, hasNonce: Boolean(nonce) });
  await trace(nonce ? "credited" : "credited_no_nonce");

  // The claim token is intentionally not echoed back: this response goes to
  // Helio's infrastructure, not the buyer.
  return NextResponse.json({ ok: Boolean(claimToken), tier });
}

function parseAdditional(value: unknown): Record<string, unknown> | null {
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}
