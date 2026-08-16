import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { scanCredits } from "@/lib/db/schema";
import { checkCredit } from "@/lib/db/credits";

/**
 * After Helio's widget reports success the browser polls here with the payment
 * id, because the server-to-server webhook can land a moment later. Returns the
 * claim token only once the webhook has actually confirmed the payment.
 */
export async function GET(request: NextRequest) {
  const paymentId = request.nextUrl.searchParams.get("paymentId")?.trim();
  const claim = request.nextUrl.searchParams.get("claim")?.trim();

  // Lets the UI show remaining entitlement for a token it already holds.
  if (claim) {
    const status = await checkCredit(claim);
    return NextResponse.json(status);
  }

  if (!paymentId) {
    return NextResponse.json({ error: "Missing paymentId" }, { status: 400 });
  }

  const db = getDb();
  if (!db) return NextResponse.json({ error: "Database not configured" }, { status: 503 });

  const rows = await db
    .select({ claimToken: scanCredits.claimToken, tier: scanCredits.tier })
    .from(scanCredits)
    .where(eq(scanCredits.paymentId, paymentId))
    .limit(1);

  if (rows.length === 0) {
    return NextResponse.json({ pending: true }, { status: 202 });
  }
  return NextResponse.json({ claimToken: rows[0].claimToken, tier: rows[0].tier });
}
