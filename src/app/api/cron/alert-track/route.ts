import { NextResponse, type NextRequest } from "next/server";
import { isCronRequest } from "@/lib/cronAuth";
import {
  applyCandlePeak,
  applyMcapSample,
  fetchPeakRotation,
  fetchTrackingTokens,
  pruneEvents,
  recordTokenPool,
  secondsSinceLastEvent,
  touchAthChecked,
} from "@/lib/db/alerts";
import { resolveSupply } from "@/lib/alerts/pricing";
import { isTelegramConfigured, sendPlainMessage } from "@/lib/alerts/telegram";
import { fetchPeakSincePaid, fetchPricesMulti } from "@/lib/solanaTracker";
import { fetchPeakSince, fetchSpotQuotes, resolvePoolAddress } from "@/lib/prices/free";
import {
  MAX_CANDLE_JUMP_X,
  PAID_PEAK_CHECKS_PER_SWEEP,
  PEAK_CHECKS_PER_SWEEP,
} from "@/lib/alerts/config";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const CHAIN = "solana";

/**
 * Every ten minutes: sample every tracked token's market cap, reconcile peaks
 * against candles, prune expired events, and check the stream is still alive.
 *
 * The market-cap sampling is the scoreboard. Every alert pins the cap it fired
 * at; this keeps the running maximum, and the ratio of the two is the only
 * honest answer to "which kind of alert is actually worth reading". Without it
 * the product can generate alerts forever and never prove one of them worked.
 *
 * **The ten-minute cron interval is deliberately unchanged.** The peak pass may
 * use 240s of a 300s `maxDuration`, so a five-minute schedule would overlap its
 * own previous run — two sweeps reading the same rotation, doubling the calls
 * against a 30-a-minute free tier and inviting the 429s that make a peak check
 * fail. Freshness came from the budget instead: 75 checks a sweep covers the
 * whole hot band, so every live call's peak is now at most one tick old.
 */

/** Longer than an hour of silence means the stream is probably dead. Helius
 * auto-disables a webhook whose receiver keeps failing and does not tell you;
 * the previous webhook on this account died that way and stayed dead for
 * weeks. */
const HEARTBEAT_SILENCE_SECONDS = 90 * 60;

/** Tokens per sweep. At one alert per token per hour this is far more headroom
 * than the alert rate needs, and it bounds the upstream spend of a runaway. */
const MAX_TOKENS_PER_SWEEP = 300;

/** Wall clock the peak pass may use before it yields. `maxDuration` is 300s and
 * the work after this loop — pruning and the stream heartbeat — must always
 * get to run, so the pass stops well short rather than risking the kill.
 *
 * 240s, up from 200s. The spot pass ahead of it is a handful of batched
 * DexScreener calls plus sequential updates and measures in single-digit
 * seconds; the three statements after it are fast. 60s of headroom is the guard,
 * and every extra second buys most of another peak reconciliation. */
const PEAK_PASS_DEADLINE_MS = 240_000;

export async function GET(request: NextRequest) {
  if (!isCronRequest(request)) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  const started = Date.now();
  let sampled = 0;
  let alertsUpdated = 0;
  let supplyBackfilled = 0;
  let fellBack = 0;
  let poolsLearned = 0;
  let peakChecks = 0;
  let paidPeakChecks = 0;
  let paidPeaksUsed = 0;
  let peaksRaised = 0;
  let peaksRejected = 0;
  let peaksRetired = 0;
  let peakPassTruncated = false;

  try {
    const targets = await fetchTrackingTokens(CHAIN, MAX_TOKENS_PER_SWEEP);

    if (targets.length > 0) {
      const mints = targets.map((t) => t.tokenAddress);

      // Free first. DexScreener takes 30 mints per request and costs nothing, so
      // a whole sweep is a handful of calls against a paid credit each.
      const spot = await fetchSpotQuotes(mints);

      // Solana Tracker only for what the free source could not answer. Neither
      // free provider publishes an SLA and a brand-new pump.fun mint can take a
      // moment to appear in an index, so the paid path stays wired — it is now
      // the exception rather than every sample.
      const missing = mints.filter((m) => !spot.has(m));
      const fallback = missing.length > 0 ? await fetchPricesMulti(missing) : null;
      if (fallback) fellBack = missing.length;

      for (const target of targets) {
        const free = spot.get(target.tokenAddress);
        const quote = free ?? fallback?.get(target.tokenAddress);
        if (!quote) continue;

        // DexScreener already names the pair, so a token's pool is usually
        // cached for free on the first spot read — no lookup call needed.
        if (free?.poolAddress && !target.poolAddress) {
          await recordTokenPool(CHAIN, target.tokenAddress, free.poolAddress, "dexscreener");
          target.poolAddress = free.poolAddress;
          poolsLearned++;
        }

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

    {
      // --- The peak pass ---
      //
      // A running maximum of spot checks is not an all-time high. $Link was
      // recorded at $1.19M because that was the highest of seven glances; it
      // traded at $2.22M, and its whole run above $1.3M lasted thirteen
      // minutes. Candle highs fix that, and they fix it *retroactively* — a
      // spike at 04:29 is in the 04:29 candle forever — so this rotates through
      // the tracked set instead of trying to be timely.
      //
      // Its own queue, not a slice of the spot targets: the two have different
      // cadences, and nesting it meant a tick with nothing due for sampling did
      // no peak work at all.
      //
      // The queue is now DUE-GATED by the call's age rather than a flat
      // stalest-first rotation, and dead tokens retire after one reconciliation
      // (`peak_final`). On the live set that reclaimed 54% of a rate-limited
      // budget that was going to numbers which cannot move, while the calls
      // currently running waited 2.3 hours for a slot.
      const rotation = await fetchPeakRotation(CHAIN, PEAK_CHECKS_PER_SWEEP);

      for (const target of rotation) {
        // The peak pass is deliberately throttled, so it is the one thing here
        // that can run long. Stopping early costs a slower rotation; being
        // killed by the platform costs the event pruning and the stream
        // heartbeat that run after this loop, and those are not optional.
        if (Date.now() - started > PEAK_PASS_DEADLINE_MS) {
          peakPassTruncated = true;
          break;
        }

        // Price x the supply pinned at alert time, exactly as the spot path
        // does, so a supply change can never masquerade as a market-cap move.
        // Checked BEFORE spending a call: without a supply there is nothing to
        // multiply a candle high by, so the read could only be thrown away.
        const supply = target.supplyAtAlert;
        if (!supply || supply <= 0) {
          await touchAthChecked(CHAIN, target.tokenAddress, target.dead);
          continue;
        }

        // --- Free first ---
        let pool = target.poolAddress;
        if (!pool) {
          pool = await resolvePoolAddress(target.tokenAddress);
          if (pool) {
            await recordTokenPool(CHAIN, target.tokenAddress, pool, "geckoterminal");
            poolsLearned++;
          }
        }

        let peak = pool
          ? await fetchPeakSince(pool, target.firstAlertAt, target.tokenAddress)
          : null;
        if (pool) peakChecks++;

        // --- Paid, only for the hole the free path left ---
        //
        // No pool, an empty candle list, a 429 or a timeout all land here, and
        // all of them otherwise leave a wrong peak on the public feed until the
        // token happens to resolve — which for a mint GeckoTerminal never
        // indexes is never. `/chart` is keyed by MINT, so it works precisely
        // when pool resolution is what failed, and it is windowed by
        // `time_from`, so it cannot credit the call with an earlier run.
        //
        // The budget is the safety, not the saving: an outage on the free
        // provider turns every check in the sweep into a fallback, and that
        // wants a ceiling rather than a surprise on the invoice.
        if (!peak && paidPeakChecks < PAID_PEAK_CHECKS_PER_SWEEP) {
          paidPeakChecks++;
          peak = await fetchPeakSincePaid(target.tokenAddress, target.firstAlertAt);
          if (peak) paidPeaksUsed++;
        }

        if (!peak) {
          // Nothing priced it. Retire it only if it is also dead — the spot
          // sampler has already abandoned it, so nothing left can move the
          // number and it would otherwise take a slot every sweep forever.
          await touchAthChecked(CHAIN, target.tokenAddress, target.dead);
          continue;
        }

        const candleMcap = peak.highPriceUsd * supply;

        // The gate. Candle data reaches the public podium and the pinned
        // Telegram message with nobody in between, so a bad read is a
        // fabricated number rather than an imprecise one. Rejected against the
        // best spot cap ever observed, which comes from a different provider on
        // a different path and is therefore a real check.
        const ceiling = Math.max(target.bestSpotMcapUsd, 0) * MAX_CANDLE_JUMP_X;
        if (ceiling > 0 && candleMcap > ceiling) {
          peaksRejected++;
          console.warn(
            `[cron/alert-track] rejected candle peak for ${target.tokenAddress}: ` +
              `${Math.round(candleMcap)} vs spot ceiling ${Math.round(ceiling)}`
          );
          // Deliberately NOT retired, dead or not: a rejected read is a bad
          // read, and retiring on one would make a provider bug permanent.
          await touchAthChecked(CHAIN, target.tokenAddress);
          continue;
        }

        // `target.dead` retires the call from this rotation. A token under
        // DEAD_MCAP_USD has already been dropped by the spot sampler, so this
        // reconciliation is the last word on its peak — and re-reading a
        // settled number every sweep is what was starving the live calls.
        const raised = await applyCandlePeak(
          CHAIN,
          target.tokenAddress,
          candleMcap,
          peak.highAt,
          target.dead
        );
        if (raised > 0) peaksRaised++;
        if (target.dead) peaksRetired++;
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
      paidFallbacks: fellBack,
      poolsLearned,
      peakChecks,
      paidPeakChecks,
      paidPeaksUsed,
      peakBudget: PEAK_CHECKS_PER_SWEEP,
      peaksRaised,
      peaksRetired,
      peaksRejected,
      peakPassTruncated,
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
