import { NextResponse } from "next/server";
import { isAdminRequest } from "@/lib/adminAuth";
import { fetchAdminStats } from "@/lib/db/adminStats";

export const dynamic = "force-dynamic";

/** Refresh feed for the dashboard. Gated on the same signed cookie as the page. */
export async function GET() {
  if (!(await isAdminRequest())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const stats = await fetchAdminStats();
  if (!stats) {
    return NextResponse.json({ error: "Database not configured." }, { status: 503 });
  }
  return NextResponse.json(stats, { headers: { "Cache-Control": "no-store" } });
}
