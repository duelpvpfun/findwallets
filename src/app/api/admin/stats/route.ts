import { NextResponse } from "next/server";
import { isAdminRequest } from "@/lib/adminAuth";
import { fetchAdminStats } from "@/lib/db/adminStats";

export const dynamic = "force-dynamic";

/** Each poll costs 11 queries, and a couple of open tabs plus a stray refresh
 * multiplies that. Snapshots are reused briefly so extra pollers are free. */
const CACHE_MS = 15_000;
let snapshot: { at: number; data: Awaited<ReturnType<typeof fetchAdminStats>> } | null = null;

/** Refresh feed for the dashboard. Gated on the same signed cookie as the page. */
export async function GET() {
  if (!(await isAdminRequest())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (snapshot && Date.now() - snapshot.at < CACHE_MS && snapshot.data) {
    return NextResponse.json(snapshot.data, { headers: { "Cache-Control": "no-store" } });
  }

  const stats = await fetchAdminStats();
  if (stats) snapshot = { at: Date.now(), data: stats };
  if (!stats) {
    return NextResponse.json({ error: "Database not configured." }, { status: 503 });
  }
  return NextResponse.json(stats, { headers: { "Cache-Control": "no-store" } });
}
