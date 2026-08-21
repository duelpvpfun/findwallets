import { NextResponse, type NextRequest } from "next/server";
import { isCronRequest } from "@/lib/cronAuth";
import {
  applyMcapSample,
  fetchTrackingTokens,
  pruneEvents,
  secondsSinceLastEvent,
} from "@/lib/db/alerts";
import { resolveSupply } from "@/lib/alerts/pricing";
import { isTelegramConfigured, sendPlainMessage } from "@/lib/alerts/telegram";
import { fetchPricesMulti } from "@/lib/solanaTracker";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const CHAIN = "solana";

/**
 * Hourly: sample every tracked token's market cap, prune expired events, and
 * check the stream is still alive.
 *
 * The market-cap sampling is the scoreboard. Every alert pins the cap it fired
 * at; this keeps the running maximum, and the ratio of the two is the only
 * honest answer to "which kind of alert is actually worth reading". Without it
 * the product can generate alerts forever and never prove one of them worked.
 */

/** Longer than an hour of silence means the stream is probably dead. Helius
 * auto-disables a webhook whose receiver keeps failing and does not tell you;
 * the previous webhook on this account died that way and stayed dead for
 * weeks. */
const HEARTBEAT_SILENCE_SECONDS = 90 * 60;

/** Tokens per sweep. At one alert per token per hour this is far more headroom
 * than the alert rate needs, and it bounds the upstream spend of a runaway. */
const MAX_TOKENS_PER_SWEEP = 300;

export async function GET(request: NextRequest) {
  if (!isCronRequest(request)) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  const started = Date.now();
  let sampled = 0;
  let alertsUpdated = 0;
  let supplyBackfilled = 0;

  try {
    const targets = await fetchTrackingTokens(CHAIN, MAX_TOKENS_PER_SWEEP);

    if (targets.length > 0) {
      const prices = await fetchPricesMulti(targets.map((t) => t.tokenAddress));

      for (const target of targets) {
        const quote = prices.get(target.tokenAddress);
        if (!quote) continue;

        // Prefer price x the supply pinned at alert time: the pool's own
        // marketCap figure is not the one the alert's denominator came from,
        // and mixing the two would show a jump that never happened.
        let supply = target.supplyAtAlert;
        if (!supply || supply <= 0) {
          supply = await resolveSupply(target.tokenAddress);
          if (supply) supplyBackfilled++;
        }

        const mcap = supply && supply > 0 ? quote.priceUsd * supply : quote.marketCapUsd;
        if (!mcap || mcap <= 0) continue;

        // Sequential. A Promise.all across 300 tokens is the fan-out that stops
        // the transaction pooler answering — see AGENTS.md.
        alertsUpdated += await applyMcapSample(CHAIN, target.tokenAddress, mcap, quote.priceUsd);
        sampled++;
      }
    }

    const pruned = await pruneEvents();
    const silentFor = await secondsSinceLastEvent(CHAIN);

    // Null means no event has ever been recorded, which on a fresh deploy is
    // expected rather than an outage.
    const streamDead = silentFor !== null && silentFor > HEARTBEAT_SILENCE_SECONDS;
    if (streamDead && isTelegramConfigured()) {
      await sendPlainMessage(
        `⚠️ <b>Stream heartbeat</b>\nNo Solana wallet events for ${Math.round(silentFor / 60)} minutes.\n` +
          `Check the Helius webhook is still enabled — it auto-disables receivers that keep failing.`
      );
    }

    return NextResponse.json({
      tokens: targets.length,
      sampled,
      alertsUpdated,
      supplyBackfilled,
      prunedEvents: pruned,
      silentForSeconds: silentFor,
      streamDead,
      ms: Date.now() - started,
    });
  } catch (err) {
    console.error("[cron/alert-track] failed:", err);
    return NextResponse.json({ error: "Tracking sweep failed." }, { status: 500 });
  }
}
