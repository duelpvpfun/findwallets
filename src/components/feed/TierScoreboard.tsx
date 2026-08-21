"use client";

import { formatMultiple } from "@/lib/format";
import type { TierScore } from "@/lib/db/alerts";

/**
 * Which shape of alert is actually worth acting on.
 *
 * Operator-only, on /admin. It is the answer to "how should we tune the tiers",
 * not a claim to make to customers: an "average peak" published on a public
 * page gets read as a return somebody actually made, which it is not.
 *
 * This is the only honest answer to that question, and it is the reason the
 * hourly market-cap tracker exists at all: without it the product could
 * generate alerts forever and never prove one of them worked.
 *
 * Form: horizontal bars, **emphasis** rather than categorical. One measure
 * (average peak multiple) across nine ordered tiers, and the story is "this one
 * performs best" — so the leader takes the accent hue and everything else
 * recedes to gray. Nine categorical hues would bury exactly the row the reader
 * came for.
 *
 * `peak x` is peak market cap over the cap the alert fired at: the best a
 * reader could have done, not what anyone did do. Said plainly in the footnote,
 * because a scoreboard that lets people read it as realised profit is a lie.
 */

const ACCENT = "#3987e5";
const DE_EMPHASIS = "#71717a";

/** Below this many scored alerts an average is noise. The row still renders —
 * hiding it would misrepresent which tiers are firing — but it is marked and
 * never wins the emphasis. */
const MIN_CONFIDENT_SAMPLE = 5;

function pct(value: number | null): string {
  if (value === null) return "—";
  return `${Math.round(value * 100)}%`;
}

function multiple(value: number | null): string {
  return value === null ? "—" : formatMultiple(value);
}

export default function TierScoreboard({ scores }: { scores: TierScore[] }) {
  // Tiers that have never fired carry no information yet; showing nine empty
  // rows on a young feed reads as a broken page.
  const rows = scores.filter((s) => s.alerts > 0);

  if (rows.length === 0) {
    return (
      <div className="rounded-xl border border-neutral-800/80 bg-neutral-900/40 p-5">
        <h2 className="text-sm font-semibold text-neutral-200">Which alerts pay</h2>
        <p className="mt-2 text-xs leading-relaxed text-neutral-500">
          Every alert pins the market cap it fired at, and the peak is re-checked hourly for seven
          days. Once alerts start landing, this table ranks the tiers by what they actually
          returned.
        </p>
      </div>
    );
  }

  const confident = rows.filter((r) => r.scored >= MIN_CONFIDENT_SAMPLE && r.avgPeakX !== null);
  const bestTier = confident.reduce<TierScore | null>(
    (best, row) => (best === null || (row.avgPeakX ?? 0) > (best.avgPeakX ?? 0) ? row : best),
    null
  );
  const scale = Math.max(1, ...rows.map((r) => r.avgPeakX ?? 0));

  return (
    <section className="rounded-xl border border-neutral-800/80 bg-neutral-900/40 p-4 sm:p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold text-neutral-200">Which alerts pay</h2>
        <p className="text-[11px] text-neutral-500">Average peak, last 30 days</p>
      </div>

      <div className="mt-4 overflow-x-auto">
        <table className="w-full min-w-[520px] border-separate border-spacing-y-1 text-left">
          <thead>
            <tr className="text-[10px] uppercase tracking-wider text-neutral-500">
              <th scope="col" className="pb-1 font-medium">
                Tier
              </th>
              <th scope="col" className="pb-1 font-medium">
                Avg peak
              </th>
              <th scope="col" className="px-3 pb-1 text-right font-medium whitespace-nowrap">
                Median
              </th>
              <th scope="col" className="px-3 pb-1 text-right font-medium whitespace-nowrap">
                Hit 2x
              </th>
              <th scope="col" className="px-3 pb-1 text-right font-medium whitespace-nowrap">
                Best
              </th>
              <th scope="col" className="pl-3 pb-1 text-right font-medium whitespace-nowrap">
                Alerts
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const isBest = bestTier?.tier === row.tier;
              const width = row.avgPeakX ? Math.max(2, (row.avgPeakX / scale) * 100) : 0;
              const thin = row.scored < MIN_CONFIDENT_SAMPLE;

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
                      {/* Direct label on every row: the de-emphasis gray sits
                          under 3:1 on this surface, so the number has to be
                          readable without the bar. */}
                      <span
                        className={`tnum w-14 shrink-0 text-xs font-semibold ${
                          isBest ? "text-blue-300" : "text-neutral-300"
                        }`}
                      >
                        {multiple(row.avgPeakX)}
                      </span>
                    </div>
                  </td>

                  <td className="tnum px-3 text-right text-xs text-neutral-400">
                    {multiple(row.medianPeakX)}
                  </td>
                  <td className="tnum px-3 text-right text-xs text-neutral-400">
                    {pct(row.hitRate2x)}
                  </td>
                  <td className="tnum px-3 text-right text-xs text-neutral-400">
                    {multiple(row.bestPeakX)}
                  </td>
                  <td className="tnum pl-3 text-right text-xs whitespace-nowrap text-neutral-500">
                    {row.alerts}
                    {thin ? <span className="ml-1 text-neutral-600">·thin</span> : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <p className="mt-3 text-[11px] leading-relaxed text-neutral-500">
        Peak market cap divided by the cap when the alert fired — the best an entry could have
        done, not what anyone made. Alerts that fired under $20K market cap are excluded, and
        rows marked <span className="text-neutral-400">thin</span> have too few alerts to mean
        much yet.
      </p>
    </section>
  );
}
