"use client";

import { formatMultiple } from "@/lib/format";
import type { CallScore, TierScore } from "@/lib/db/alerts";

/**
 * How many good calls each tier produces, and how big they are.
 *
 * Operator-only, on /admin: it answers "how should we tune the tiers", not a
 * claim to make to customers.
 *
 * The framing is the owner's and it is the right one here. Memecoins mostly go
 * to zero, so the downside is near-constant and carries almost no information —
 * tracking it in detail was measuring the same thing over and over. What varies
 * is how OFTEN a tier catches a runner and how far those run, so that is what
 * this counts.
 *
 * Two things keep it honest:
 *
 *  - **Per day, not totals.** Tiers fire at wildly different rates; a tier with
 *    twice the hits and five times the calls is worse, not better.
 *  - **Median peak of the WINNERS.** A median over every call is ~1.00x in a
 *    market where most calls do nothing, which says nothing about the ones that
 *    worked.
 *
 * Form: a table. Six measures across nine ordered tiers is a grid to be read
 * across a row and compared down a column, which is what a table does. The one
 * bar is good-calls-per-day, because that is the column the decision turns on.
 */

const ACCENT = "#3987e5";
const DE_EMPHASIS = "#71717a";

/** Below this many scored calls a rate is noise. The row still renders — hiding
 * it would misrepresent which tiers are firing — but it is marked and never
 * wins the emphasis. */
const MIN_CONFIDENT_SAMPLE = 10;

function pct(value: number | null): string {
  return value === null ? "—" : `${Math.round(value * 100)}%`;
}

function mult(value: number | null): string {
  return value === null ? "—" : formatMultiple(value);
}

/** Rates are usually fractional, and "0.4/day" is more honest than "0". */
function rate(value: number): string {
  if (value === 0) return "0";
  return value >= 10 ? Math.round(value).toString() : value.toFixed(1);
}

export default function TierScoreboard({
  scores,
  calls,
}: {
  scores: TierScore[];
  calls: CallScore;
}) {
  const rows = scores.filter((s) => s.alerts > 0);

  if (rows.length === 0) {
    return (
      <section className="rounded-xl border border-neutral-800/80 bg-neutral-900/40 p-5">
        <h2 className="text-sm font-semibold text-neutral-200">Which alerts pay</h2>
        <p className="mt-2 text-xs leading-relaxed text-neutral-500">
          Every call pins the market cap it fired at, and the peak is tracked from that moment. Once
          calls start landing this ranks the tiers by how many runners each one catches per day.
        </p>
      </section>
    );
  }

  const confident = rows.filter((r) => r.scored >= MIN_CONFIDENT_SAMPLE);
  const best = confident.reduce<TierScore | null>(
    (b, r) => (b === null || r.hits2xPerDay > b.hits2xPerDay ? r : b),
    null
  );
  const scale = Math.max(...rows.map((r) => r.hits2xPerDay), 0.1);

  return (
    <section className="rounded-xl border border-neutral-800/80 bg-neutral-900/40 p-4 sm:p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold text-neutral-200">Which alerts pay</h2>
        <p className="text-[11px] text-neutral-500">Last 30 days</p>
      </div>

      {/* The numbers the whole table exists to produce. Counted per CALL, not
          per row: a token escalating 2 -> 6 writes five rows, and summing the
          tier table below counted that one call five times. */}
      <div className="mt-3 flex flex-wrap gap-x-8 gap-y-2 border-b border-neutral-800/60 pb-3">
        <div>
          <div className="text-[10px] uppercase tracking-wider text-neutral-500">
            Good calls / day
          </div>
          <div className="tnum mt-0.5 text-xl font-semibold text-blue-300">
            {rate(calls.hits2xPerDay)}
            <span className="ml-1 text-xs font-normal text-neutral-500">2x+</span>
          </div>
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-wider text-neutral-500">Calls / day</div>
          <div className="tnum mt-0.5 text-xl font-semibold text-neutral-50">
            {rate(calls.callsPerDay)}
          </div>
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-wider text-neutral-500">Best call</div>
          <div className="tnum mt-0.5 text-xl font-semibold text-neutral-50">
            {mult(calls.bestPeakX)}
          </div>
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-wider text-neutral-500">5x+ / 10x+</div>
          <div className="tnum mt-0.5 text-xl font-semibold text-neutral-50">
            {calls.hits5x}
            <span className="text-neutral-600"> / </span>
            {calls.hits10x}
          </div>
        </div>
      </div>

      <div className="mt-3 overflow-x-auto">
        <table className="w-full min-w-[640px] border-separate border-spacing-y-1 text-left">
          <thead>
            <tr className="text-[10px] uppercase tracking-wider text-neutral-500">
              <th scope="col" className="pb-1 font-medium">Tier</th>
              <th scope="col" className="pb-1 font-medium">Good calls / day (2x+)</th>
              <th scope="col" className="px-3 pb-1 text-right font-medium whitespace-nowrap">Calls / day</th>
              <th scope="col" className="px-3 pb-1 text-right font-medium whitespace-nowrap" title="Share of scored calls that reached 2x">
                Hit rate
              </th>
              <th scope="col" className="px-3 pb-1 text-right font-medium whitespace-nowrap" title="Median peak among the calls that reached 2x">
                Winner size
              </th>
              <th scope="col" className="px-3 pb-1 text-right font-medium whitespace-nowrap">5x / 10x</th>
              <th scope="col" className="px-3 pb-1 text-right font-medium whitespace-nowrap">Best</th>
              <th scope="col" className="pl-3 pb-1 text-right font-medium whitespace-nowrap">Scored</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const isBest = best?.tier === row.tier;
              const thin = row.scored < MIN_CONFIDENT_SAMPLE;
              const width = row.hits2xPerDay > 0 ? Math.max(2, (row.hits2xPerDay / scale) * 100) : 0;

              return (
                <tr key={row.tier} className="align-middle">
                  <th scope="row" className="w-24 pr-3 text-xs font-medium whitespace-nowrap text-neutral-300">
                    {row.tier} wallets
                  </th>

                  <td className="w-full pr-3">
                    <div className="flex items-center gap-2">
                      <div className="h-2.5 min-w-[3rem] flex-1 overflow-hidden rounded-sm bg-neutral-800/60">
                        <div
                          className="h-full rounded-r-[4px]"
                          style={{
                            width: `${width}%`,
                            backgroundColor: isBest ? ACCENT : DE_EMPHASIS,
                          }}
                        />
                      </div>
                      {/* Direct label on every row: the de-emphasis grey is under
                          3:1 on this surface, so the number has to be readable
                          without the bar. */}
                      <span
                        className={`tnum w-12 shrink-0 text-xs font-semibold ${
                          isBest ? "text-blue-300" : "text-neutral-300"
                        }`}
                      >
                        {rate(row.hits2xPerDay)}
                      </span>
                    </div>
                  </td>

                  <td className="tnum px-3 text-right text-xs text-neutral-400">{rate(row.callsPerDay)}</td>
                  <td className="tnum px-3 text-right text-xs text-neutral-400">{pct(row.hitRate2x)}</td>
                  <td className="tnum px-3 text-right text-xs text-neutral-300">{mult(row.medianWinnerPeakX)}</td>
                  <td className="tnum px-3 text-right text-xs text-neutral-400">
                    {row.hits5x}
                    <span className="text-neutral-600"> / </span>
                    {row.hits10x}
                  </td>
                  <td className="tnum px-3 text-right text-xs text-neutral-300">{mult(row.bestPeakX)}</td>
                  <td className="tnum pl-3 text-right text-xs whitespace-nowrap text-neutral-500">
                    {row.scored}
                    <span className="text-neutral-600">/{row.alerts}</span>
                    {thin ? <span className="ml-1 text-neutral-600">·thin</span> : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <p className="mt-3 text-[11px] leading-relaxed text-neutral-500">
        Peak market cap over the cap when the call fired.{" "}
        <span className="text-neutral-400">Winner size</span> is the median peak of the calls that
        reached 2x — a median over all of them is ~1.00x and says nothing about the ones that
        worked. <span className="text-neutral-400">Scored</span> counts calls old enough to have an
        observed peak, out of all that fired. The headline figures count calls, not escalation
        steps: a token that goes 2 → 6 wallets is one call, not five. Rates are per day over the
        period actually covered, floored at one day, so a feed only hours old reads as a running
        total rather than an extrapolation.
      </p>
    </section>
  );
}
