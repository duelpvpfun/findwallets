import { timingSafeEqual } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { processDelivery } from "@/lib/alerts/engine";
import type { HeliusEnhancedTransaction } from "@/lib/alerts/classify";

export const dynamic = "force-dynamic";
// Escalation costs a handful of sequential statements plus, on the rare
// delivery that actually fires, one upstream metadata call and one Telegram
// send. Well under this, but Helius gives up on a slow receiver.
export const maxDuration = 30;

/**
 * The Helius enhanced-webhook receiver: the only ingress for the alert stream.
 *
 * Completely separate from the paid scan path, by design. A broken alert must
 * never be able to cost a buyer a credit, so this route shares no code with
 * `/api/top-traders` beyond the pricing helpers, and it returns 200 for
 * anything it cannot process.
 *
 * **Why it always returns 200.** Helius retries every non-2xx and auto-disables
 * a webhook that keeps failing — "100.0% failure rate over 7d" is exactly how
 * the previous webhook on this account died, silently, while its dashboard
 * still looked healthy. A malformed delivery is not worth that risk, so parse
 * and processing failures are logged and acknowledged. Only a failed auth check
 * gets a 401, because that is the one case where a retry is not wanted either.
 */
function isAuthorized(request: NextRequest): boolean {
  const expected = process.env.HELIUS_WEBHOOK_SECRET;
  // A missing secret denies rather than opens the endpoint. Anyone who knows
  // the URL could otherwise inject fabricated buys straight into the alerts.
  if (!expected) return false;

  const header = request.headers.get("authorization") ?? "";
  const provided = header.startsWith("Bearer ") ? header.slice(7) : header;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function POST(request: NextRequest) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  let transactions: HeliusEnhancedTransaction[];
  try {
    const body = await request.json();
    // Helius posts an array. A single object is accepted too so a hand-made
    // replay of one captured transaction works without wrapping it.
    transactions = Array.isArray(body) ? body : [body];
  } catch {
    console.error("[stream/solana] unparseable body");
    return NextResponse.json({ ok: true, ignored: "unparseable" });
  }

  try {
    const report = await processDelivery(transactions);
    if (report.fired.length > 0) {
      console.log("[stream/solana] fired:", JSON.stringify(report.fired));
    }
    if (report.solPriceStale) {
      // Every SOL-quoted trade is being sized off a stale price. Tiers still
      // fire, but the $50 floor is being applied against yesterday's SOL.
      console.warn("[stream/solana] SOL price is stale");
    }
    return NextResponse.json({
      ok: true,
      transactions: report.transactions,
      classified: report.classified,
      inserted: report.inserted,
      fired: report.fired.length,
    });
  } catch (err) {
    console.error("[stream/solana] delivery failed:", err);
    return NextResponse.json({ ok: false, error: "processing-failed" });
  }
}

/** Helius pings the URL when a webhook is created or edited. */
export async function GET() {
  return NextResponse.json({ ok: true, receiver: "helius-enhanced", chain: "solana" });
}
