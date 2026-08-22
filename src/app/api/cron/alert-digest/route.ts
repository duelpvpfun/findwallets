import { NextResponse, type NextRequest } from "next/server";
import { isCronRequest } from "@/lib/cronAuth";
import {
  attachBotMessageId,
  claimBotMessage,
  countDeliveredCalls,
  fetchTopCalls,
  releaseBotMessage,
} from "@/lib/db/alerts";
import {
  DIGEST_HOUR_LOCAL,
  DIGEST_TOP_N,
  DIGEST_TZ,
  DIGEST_WINDOW_HOURS,
} from "@/lib/alerts/config";
import {
  buildLeaderboardMessage,
  isTelegramConfigured,
  sendDigestMessage,
  telegramChatId,
} from "@/lib/alerts/telegram";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const CHAIN = "solana";

/**
 * The daily recap: one post a day at 2pm New York, the owner's call 2026-08-22.
 *
 * **This route runs every hour and posts at most once a day.** That is not a
 * workaround, it is the only way to hit a local hour: Vercel cron expressions
 * are UTC, and America/New_York is UTC-4 for two thirds of the year and UTC-5
 * for the rest. A fixed `0 19 * * *` would be 2pm in January and 3pm in July,
 * and would need remembering twice a year. Comparing the local hour instead is
 * exact and needs nothing.
 *
 * Separate from the pin on purpose. The pin is what a stranger who opens the
 * channel reads and it rewrites itself silently; the recap is a real post that
 * notifies, for subscribers who scrolled past today's alerts and want to know
 * which of them went anywhere. Both read the same rows through the same builder,
 * so they cannot disagree about what a call did.
 */
export async function GET(request: NextRequest) {
  if (!isCronRequest(request)) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  const chatId = telegramChatId();
  if (!isTelegramConfigured() || !chatId) {
    return NextResponse.json({ skipped: "telegram-not-configured" });
  }

  const started = Date.now();
  const force = request.nextUrl.searchParams.get("force") === "1";
  const dry = request.nextUrl.searchParams.get("dry") === "1";
  const local = localParts(started);

  // A missed 2pm catches up later the same day rather than being skipped: a
  // recap at 4pm because the 2pm run failed is worth more than no recap, and
  // the day's claim guarantees it still only happens once.
  if (!force && local.hour < DIGEST_HOUR_LOCAL) {
    return NextResponse.json({
      skipped: "before-digest-hour",
      localHour: local.hour,
      digestHour: DIGEST_HOUR_LOCAL,
      tz: DIGEST_TZ,
    });
  }

  const kind = `digest-${local.day}`;

  try {
    // Sequential, never `Promise.all` — a fan-out wider than the pool of three
    // is a hang, not a speed-up.
    const calls = await fetchTopCalls(CHAIN, DIGEST_WINDOW_HOURS, DIGEST_TOP_N);
    const totalCalls = await countDeliveredCalls(CHAIN, DIGEST_WINDOW_HOURS);

    const text = buildLeaderboardMessage({
      calls,
      chain: CHAIN,
      windowHours: DIGEST_WINDOW_HOURS,
      totalCalls,
      now: started,
      variant: "daily",
      dayLabel: local.label,
    });

    if (dry) {
      return NextResponse.json({
        action: "dry-run",
        kind,
        localHour: local.hour,
        calls: calls.length,
        totalCalls,
        text,
      });
    }

    // The claim, and the whole once-a-day guarantee. An INSERT that either
    // takes the day's primary key or does not — never a read of "have we
    // posted yet" followed by a write, which two concurrent deliveries both
    // pass. `force` cannot override this: re-posting on demand is what a
    // second recap in one day looks like.
    if (!(await claimBotMessage(kind, chatId))) {
      return NextResponse.json({ skipped: "already-posted-today", kind });
    }

    const sent = await sendDigestMessage(text);
    if (!sent.ok || sent.messageId === null) {
      // Give the day back. Burning the claim on a Telegram outage would mean no
      // recap at all today, when the next hourly pass could have posted it.
      await releaseBotMessage(kind);
      return NextResponse.json({
        action: "send-failed",
        error: sent.error ?? "no-message-id",
        kind,
        ms: Date.now() - started,
      });
    }

    await attachBotMessageId(kind, sent.messageId);

    return NextResponse.json({
      action: "posted",
      kind,
      messageId: sent.messageId,
      calls: calls.length,
      totalCalls,
      ms: Date.now() - started,
    });
  } catch (err) {
    console.error("[cron/alert-digest] failed:", err);
    return NextResponse.json({ error: "Digest failed." }, { status: 500 });
  }
}

/**
 * The hour, the calendar day and a human label, all in the owner's timezone.
 *
 * `en-CA` is here for its date format, not its language: it is the one locale
 * that yields `2026-08-22`, which sorts and makes a safe primary key. Reading
 * the hour and the day from the same `Intl` call matters at midnight — taking
 * them from two separate formatters could land either side of the boundary and
 * claim the wrong day.
 */
function localParts(now: number): { hour: number; day: string; label: string } {
  const date = new Date(now);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: DIGEST_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hour12: false,
  }).formatToParts(date);

  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === type)?.value ?? "";

  // Intl renders midnight as "24" in some locales rather than "00".
  const hour = Number(get("hour")) % 24;
  const day = `${get("year")}-${get("month")}-${get("day")}`;
  const label = new Intl.DateTimeFormat("en-US", {
    timeZone: DIGEST_TZ,
    month: "short",
    day: "numeric",
  }).format(date);

  return { hour, day, label };
}
