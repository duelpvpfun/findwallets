import { NextRequest, NextResponse } from "next/server";
import { purgeExpiredScanResults } from "@/lib/db/scanResults";
import { purgeOldNonces } from "@/lib/db/users";
import { isCronRequest } from "@/lib/cronAuth";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Daily housekeeping for the two tables that would otherwise grow forever:
 * stored scan results past their 7-day window (pinned ones are kept), and
 * sign-in challenges older than a day.
 *
 * Retention here is a promise to the user, not a capacity limit — see the note
 * in `src/lib/db/scanResults.ts`.
 *
 * One cron for both because they run on the same schedule and each is a single
 * indexed DELETE. Run strictly one after the other: a Promise.all of database
 * calls is a latent hang against Supabase's transaction pooler (see AGENTS.md).
 */
export async function GET(request: NextRequest) {
  if (!isCronRequest(request)) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  try {
    const results = await purgeExpiredScanResults();
    const nonces = await purgeOldNonces(24);
    if (results > 0 || nonces > 0) {
      console.warn(`[cron] purged ${results} expired scan result(s), ${nonces} old nonce(s)`);
    }
    return NextResponse.json({ results, nonces });
  } catch (err) {
    console.error("[cron/purge-scan-results] failed:", err);
    return NextResponse.json({ error: "Purge failed." }, { status: 500 });
  }
}
