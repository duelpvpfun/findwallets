import { NextResponse, type NextRequest } from "next/server";
import { isCronRequest } from "@/lib/cronAuth";
import {
  clearPinnedMessage,
  countDeliveredCalls,
  fetchPinnedMessage,
  fetchTopCalls,
  recordPinnedMessage,
  touchPinnedMessage,
} from "@/lib/db/alerts";
import { PIN_TOP_N, PIN_WINDOW_HOURS } from "@/lib/alerts/config";
import {
  buildLeaderboardMessage,
  editMessage,
  isMessageGone,
  isTelegramConfigured,
  pinMessage,
  sendPinnedMessage,
  telegramChatId,
} from "@/lib/alerts/telegram";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const CHAIN = "solana";

/** One row in `pinned_messages`. A second kind of pin later is a second key,
 * not a second table. */
const PIN_KIND = "leaderboard";

/**
 * Hourly: keep a pinned leaderboard of the best calls at the top of the channel.
 *
 * **One message, edited in place.** Posting a fresh leaderboard every hour would
 * put 24 messages a day into a channel whose entire value is the alerts, and
 * only one message can be pinned regardless — so the id is stored and the text
 * is rewritten. `pinned_messages` exists for exactly that.
 *
 * The pin is the one message a stranger who opens the channel is guaranteed to
 * read, and it answers one question: do these calls go anywhere. Per-call
 * results only — the same numbers already on every public feed row. Hit rates
 * and hold medians stay on /admin, where an operator's median cannot be read as
 * a return somebody made.
 *
 * Every failure here is a delivery failure and nothing more. This route shares
 * no state with the webhook or the paid scan path, so a Telegram outage costs a
 * stale pin and never an alert or a credit.
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

  try {
    // Sequential, never `Promise.all`: three concurrent queries against a pool
    // of three is the fan-out that stops the transaction pooler answering.
    const calls = await fetchTopCalls(CHAIN, PIN_WINDOW_HOURS, PIN_TOP_N);
    const totalCalls = await countDeliveredCalls(CHAIN, PIN_WINDOW_HOURS);
    const existing = await fetchPinnedMessage(PIN_KIND);

    const text = buildLeaderboardMessage({
      calls,
      chain: CHAIN,
      windowHours: PIN_WINDOW_HOURS,
      totalCalls,
      now: started,
    });

    // A dry run renders exactly what would be pinned and posts nothing, so the
    // copy can be reviewed before it sits at the top of the channel for an hour.
    if (request.nextUrl.searchParams.get("dry") === "1") {
      return NextResponse.json({ action: "dry-run", calls: calls.length, totalCalls, text });
    }

    // A message id means nothing outside the chat it was posted in, so a
    // repointed TELEGRAM_ALERT_CHAT_ID must post afresh rather than edit an id
    // that now belongs to a different channel.
    const reusable = existing && existing.chatId === chatId ? existing.messageId : null;

    if (reusable !== null) {
      const edited = await editMessage(reusable, text);
      if (edited.ok) {
        await touchPinnedMessage(PIN_KIND);
        return NextResponse.json({
          action: "edited",
          messageId: reusable,
          calls: calls.length,
          totalCalls,
          ms: Date.now() - started,
        });
      }
      // Only a message Telegram no longer has justifies posting a second one.
      // Any other error (rate limit, network) leaves the existing pin alone and
      // retries next hour — re-posting on a transient failure is how a channel
      // ends up with six abandoned leaderboards.
      if (!isMessageGone(edited.error)) {
        return NextResponse.json({
          action: "edit-failed",
          error: edited.error,
          messageId: reusable,
          ms: Date.now() - started,
        });
      }
      await clearPinnedMessage(PIN_KIND);
    }

    const sent = await sendPinnedMessage(text);
    if (!sent.ok || sent.messageId === null) {
      return NextResponse.json({
        action: "send-failed",
        error: sent.error ?? "no-message-id",
        ms: Date.now() - started,
      });
    }

    // Recorded before the pin is attempted, and regardless of whether it
    // succeeds. A bot without "Pin Messages" still posted a real message, and
    // forgetting its id would post another one every hour until somebody
    // noticed the permission.
    await recordPinnedMessage(PIN_KIND, chatId, sent.messageId);
    const pinned = await pinMessage(sent.messageId);

    return NextResponse.json({
      action: "posted",
      messageId: sent.messageId,
      pinned: pinned.ok,
      pinError: pinned.error,
      calls: calls.length,
      totalCalls,
      ms: Date.now() - started,
    });
  } catch (err) {
    console.error("[cron/alert-pin] failed:", err);
    return NextResponse.json({ error: "Pin refresh failed." }, { status: 500 });
  }
}
