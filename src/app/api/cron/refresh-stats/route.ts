import { NextRequest, NextResponse } from "next/server";
import { refreshAdminStatsSnapshot } from "@/lib/db/adminStats";
import { isCronRequest } from "@/lib/cronAuth";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request: NextRequest) {
  if (!isCronRequest(request)) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  try {
    const refreshed = await refreshAdminStatsSnapshot();
    return NextResponse.json({ refreshed });
  } catch (err) {
    console.error("[cron/refresh-stats] failed:", err);
    return NextResponse.json({ error: "Refresh failed." }, { status: 500 });
  }
}
