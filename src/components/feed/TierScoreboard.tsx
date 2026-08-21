"use client";

import { formatMultiple } from "@/lib/format";
import type { TierScore } from "@/lib/db/alerts";

/**
 * Which shape of alert is actually worth acting on.
 *
 * Operator-only, on /admin. It is the answer to "how should we tune the tiers",
 * not a claim to make to customers: an "average peak" published on a public
 * page gets read as a return somebody made, which it is not.
 *
 * Every column here exists to stop this table flattering itself. The peak alone
 * is >= 1.00x by construction — it is a running maximum seeded at the entry cap
 * — so it sits next to the drawdown, the 24-hour mark and a rug rate, and all
 * three of those can be bad. A tier with a 4x median peak and a 0.2x median
 * drawdown is a tier nobody could actually have traded.
 *
 * Medians, not means, on every distribution: one 50x in a hundred calls drags a
 * mean wherever it likes.
 *
 * Form: a table, not a chart. Seven measures across nine ordered tiers is a
 * grid of numbers to be read across a row and compared down a column, which is
 * what a table does and what any chart of it would obscure. The one bar is the
 * 24-hour median, because that is the column the decision actually turns on.
 */

const ACCENT = "#3987e5";
const DE_EMPHASIS = "#71717a";
const LOSS = "#d03b3b";

/** Below this many scored calls a median is noise. The row still renders —
 * hiding it would misrepresent which tiers are firing — but it is marked and
 * never wins the emphasis. */
const MIN_CONFIDENT_SAMPLE = 8;

function pct(value: number | null): string {
  return value === null ? "—" : `${Math.round(value * 100)}%`;
}

function mult(value: number | null): string {
  return value === null ? "—" : formatMultiple(value);
}

export default function TierScoreboard({ scores }: { scores: TierScore[] }) {
  const rows = scores.filter((s) => s.alerts > 0);

  if (rows.length === 0) {
    return (
      <section className="rounded-xl border border-neutral-800/80 bg-neutral-900/40 p-5">
        <h2 className="text-sm font-semibold text-neutral-200">Which alerts pay</h2>
        <p className="mt-2 text-xs leading-relaxed text-neutral-500">
          Every call pins the market cap it fired at. The peak, the drawdown and the cap 24 hours
          later are all tracked from that moment, so once calls start landing this ranks the tiers
          by what they actually did.
        </p>
      </section>
    );
  }

  // Judged on the 24-hour median, which is the closest thing here to a result
  // somebody could have taken. Ranking on peak would just crown whichever tier
  // happened to catch one runner.
  const confident = rows.filter((r) => r.scored24h >= MIN_CONFIDENT_SAMPLE && r.median24hX !== null);
  const best = confident.reduce<TierScore | null>(
    (b, r) => (b === null || (r.median24hX ?? 0) > (b.median24hX ?? 0) ? r : b),
    null
  );
  const scale = Math.max(1, ...rows.map((r) => r.median24hX ?? 0));

  return (
    <section className="rounded-xl border border-neutral-800/80 bg-neutral-900/40 p-4 sm:p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold text-neutral-200">Which alerts pay</h2>
        <p className="text-[11px] text-neutral-500">Medians, last 30 days</p>
      </div>

      <div className="mt-4 overflow-x-auto">
        <table className="w-full min-w-[680px] border-separate border-spacing-y-1 text-left">
          <thead>
            <tr className="text-[10px] uppercase tracking-wider text-neutral-500">
              <th scope="col" className="pb-1 font-medium">Tier</th>
              <th scope="col" className="pb-1 font-medium">At 24h (median)</th>
              <th scope="col" className="px-3 pb-1 text-right font-medium whitespace-nowrap" title="Median peak market cap over the cap at the call. An upper bound, not a result.">
                Peak
              </th>
              <th scope="col" className="px-3 pb-1 text-right font-medium whitespace-nowrap" title="Median lowest market cap over the cap at the call. Below 1 means it went underwater first.">
                Low
              </th>
              <th scope="col" className="px-3 pb-1 text-right font-medium whitespace-nowrap" title="Share that touched 2x at any point">
                Hit 2x
              </th>
              <th scope="col" className="px-3 pb-1 text-right font-medium whitespace-nowrap" title="Share that fell 70% or more from the call">
                Rugged
              </th>
              <th scope="col" className="px-3 pb-1 text-right font-medium whitespace-nowrap" title="Share still at or above the call after 24 hours">
                Green 24h
              </th>
              <th scope="col" className="pl-3 pb-1 text-right font-medium whitespace-nowrap">Calls</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const isBest = best?.tier === row.tier;
              const thin = row.scored24h < MIN_CONFIDENT_SAMPLE;
              const x24 = row.median24hX;
              const width = x24 ? Math.max(2, Math.min(100, (x24 / scale) * 100)) : 0;
              const underwater = x24 !== null && x24 < 1;

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
                            backgroundColor: underwater ? LOSS : isBest ? ACCENT : DE_EMPHASIS,
                          }}
                        />
                      </div>
                      {/* Direct label on every row: the de-emphasis grey is under
                          3:1 on this surface, so the number must be readable
                          without the bar. */}
                      <span
                        className={`tnum w-14 shrink-0 text-xs font-semibold ${
                          x24 === null
                            ? "text-neutral-500"
                            : underwater
                            ? "text-rose-400"
                            : isBest
                            ? "text-blue-300"
                            : "text-neutral-300"
                        }`}
                      >
                        {mult(x24)}
                      </span>
                    </div>
                  </td>

                  <td className="tnum px-3 text-right text-xs text-neutral-400">{mult(row.medianPeakX)}</td>
                  <td className="tnum px-3 text-right text-xs text-rose-400/80">{mult(row.medianDrawdownX)}</td>
                  <td className="tnum px-3 text-right text-xs text-neutral-400">{pct(row.hitRate2x)}</td>
                  <td className="tnum px-3 text-right text-xs text-rose-400/80">{pct(row.rugRate)}</td>
                  <td className="tnum px-3 text-right text-xs text-neutral-400">{pct(row.greenAt24h)}</td>
                  <td className="tnum pl-3 text-right text-xs whitespace-nowrap text-neutral-500">
                    {row.alerts}
                    {row.scored24h > 0 ? (
                      <span className="text-neutral-600">/{row.scored24h}</span>
                    ) : null}
                    {thin ? <span className="ml-1 text-neutral-600">·thin</span> : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <p className="mt-3 text-[11px] leading-relaxed text-neutral-500">
        All against the market cap when the call fired. <span className="text-neutral-400">Peak</span>{" "}
        is an upper bound and is always at least 1.00x by construction — read it next to{" "}
        <span className="text-neutral-400">Low</span>, which is how far underwater it went first.{" "}
        <span className="text-neutral-400">At 24h</span> is the closest thing to a result anyone
        could have taken. Calls that fired under $20K cap are excluded; the second figure under
        Calls is how many are old enough to have a 24-hour mark.
      </p>
    </section>
  );
}
