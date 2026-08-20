import { NextRequest, NextResponse } from "next/server";
import { releaseStaleReservations } from "@/lib/db/credits";
import { isCronRequest } from "@/lib/cronAuth";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Reservations younger than this could still belong to an in-flight scan. */
const GRACE_MINUTES = 10;

export async function GET(request: NextRequest) {
  if (!isCronRequest(request)) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  try {
    const released = await releaseStaleReservations(GRACE_MINUTES);
    if (released > 0) console.warn(`[cron] released ${released} stale credit reservation(s)`);
    return NextResponse.json({ released });
  } catch (err) {
    console.error("[cron/release-stale-credits] failed:", err);
    return NextResponse.json({ error: "Sweep failed." }, { status: 500 });
  }
}
