import { NextResponse } from "next/server";
import { isAdminRequest } from "@/lib/adminAuth";
import {
  fetchAdminStats,
  readAdminStatsSnapshot,
  refreshAdminStatsSnapshot,
} from "@/lib/db/adminStats";

export const dynamic = "force-dynamic";

/** Beyond this the cron has clearly stopped running, so recompute inline rather
 * than serve figures nobody would trust. */
const STALE_AFTER_MS = 10 * 60_000;

/** Refresh feed for the dashboard. Gated on the same signed cookie as the page.
 * Reads the cron-maintained snapshot row, so polling costs one indexed query
 * regardless of how many tabs are open or how large the tables have grown. */
export async function GET() {
  if (!(await isAdminRequest())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const headers = { "Cache-Control": "no-store" };

  const snapshot = await readAdminStatsSnapshot();
  if (snapshot && Date.now() - new Date(snapshot.generatedAt).getTime() < STALE_AFTER_MS) {
    return NextResponse.json(snapshot.stats, { headers });
  }

  // No snapshot yet (first deploy), or the cron has stopped running.
  const stats = await fetchAdminStats();
  if (!stats) {
    return NextResponse.json({ error: "Database not configured." }, { status: 503 });
  }
  void refreshAdminStatsSnapshot().catch(() => {
    // Best effort: the caller already has fresh figures.
  });
  return NextResponse.json(stats, { headers });
}
