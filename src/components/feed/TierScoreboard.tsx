"use client";

import { formatMultiple } from "@/lib/format";
import type { AlertCut, CallScore, SuppressionRow, TierScore } from "@/lib/db/alerts";

/**
 * How many good calls each tier produces, how big they are, and — the part this
 * grew into — whether any of the other levers matter.
 *
 * Operator-only, on /admin: it answers "how should we tune this", not a claim to
 * make to customers.
 *
 * The framing is the owner's and it is the right one here. Memecoins mostly go
 * to zero, so the downside is near-constant and carries almost no information —
 * tracking it in detail was measuring the same thing over and over. What varies
 * is how OFTEN a tier catches a runner and how far those run, so that is what
 * this counts.
 *
 * Four things keep it honest:
 *
 *  - **Per day, not totals.** Tiers fire at wildly different rates; a tier with
 *    twice the hits and five times the calls is worse, not better.
 *  - **Median peak of the WINNERS.** A median over every call is ~1.00x in a
 *    market where most calls do nothing, which says nothing about the ones that
 *    worked.
 *  - **The peak is the ceiling, not the answer.** Nobody sells the top, so the
 *    1h/6h/24h columns are here as the realistic floor — over every scored call,
 *    winners and zeros alike. They were being collected and never read.
 *  - **Every filter shows what it removed.** A suppressed call that turns out to
 *    have been good is the only evidence a knob is wrong, and evidence nothing
 *    displays is not evidence.
 *
 * Form: tables, and one bar per row. Ten measures across nine ordered tiers is a
 * grid to be read across a row and compared down a column, which is what a table
 * does. The bar is on the single column each decision turns on, and it carries
 * one accent for the leader against grey for the rest — never a colour per
 * bucket, which would spend the only free channel re-encoding the bar's length.
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

/** "18s", "24m", "3h 10m". The question behind this number is "how long did a
 * reader have", so it has to read naturally from seconds to hours. */
function minutes(value: number | null): string {
  if (value === null) return "—";
  if (value < 1) return `${Math.max(1, Math.round(value * 60))}s`;
  if (value < 60) return `${Math.round(value)}m`;
  const h = Math.floor(value / 60);
  const rem = Math.round(value % 60);
  return rem === 0 ? `${h}h` : `${h}h ${rem}m`;
}

/** A measure with its own sample count, so a dash reads as "too early" rather
 * than "no edge" — the difference matters most on the day something ships. */
function Tile({
  label,
  value,
  sub,
  accent,
}: {
  label: string;
  value: string;
  sub?: string;
  accent?: boolean;
}) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-neutral-500">{label}</div>
      <div
        className={`tnum mt-0.5 text-xl font-semibold ${
          accent ? "text-blue-300" : "text-neutral-50"
        }`}
      >
        {value}
        {sub ? <span className="ml-1 text-xs font-normal text-neutral-500">{sub}</span> : null}
      </div>
    </div>
  );
}

/** The one mark in here. 4px rounded data-end anchored to the left, thin, and
 * grey unless this row is the leader of its group. */
function Bar({ fraction, lead }: { fraction: number; lead: boolean }) {
  const width = fraction > 0 ? Math.max(2, fraction * 100) : 0;
  return (
    <div className="h-2.5 min-w-[3rem] flex-1 overflow-hidden rounded-sm bg-neutral-800/60">
      <div
        className="h-full rounded-r-[4px]"
        style={{ width: `${width}%`, backgroundColor: lead ? ACCENT : DE_EMPHASIS }}
      />
    </div>
  );
}

export default function TierScoreboard({
  scores,
  calls,
  cuts,
  suppression,
}: {
  scores: TierScore[];
  calls: CallScore;
  cuts: AlertCut[];
  suppression: SuppressionRow[];
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

  // Grouped in render order, which the query already sorted by (dimension, ord).
  const dimensions: { name: string; rows: AlertCut[] }[] = [];
  for (const cut of cuts) {
    const last = dimensions[dimensions.length - 1];
    if (last && last.name === cut.dimension) last.rows.push(cut);
    else dimensions.push({ name: cut.dimension, rows: [cut] });
  }

  const posted = suppression.find((s) => s.reason === "Posted");
  const removed = suppression.filter((s) => s.reason !== "Posted");

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
        <Tile label="Good calls / day" value={rate(calls.hits2xPerDay)} sub="2x+" accent />
        <Tile label="Calls / day" value={rate(calls.callsPerDay)} />
        <Tile label="Best call" value={mult(calls.bestPeakX)} />
        <Tile
          label="5x+ / 10x+"
          value={`${calls.hits5x} / ${calls.hits10x}`}
        />
        <Tile label="Winner size" value={mult(calls.medianWinnerPeakX)} sub="median" />
      </div>

      {/* The peak is a ceiling nobody sells into. These are the floor, and until
          now they were written by the cron every ten minutes and read by
          nothing. Deliberately over ALL scored calls including the zeros — a
          "what would holding have paid" figure that excluded the losers would be
          worthless. */}
      <div className="mt-3 flex flex-wrap gap-x-8 gap-y-2 border-b border-neutral-800/60 pb-3">
        <Tile
          label="Median at 1h"
          value={mult(calls.median1hX)}
          sub={calls.scored1h > 0 ? `n=${calls.scored1h}` : "too early"}
        />
        <Tile
          label="Median at 6h"
          value={mult(calls.median6hX)}
          sub={calls.scored6h > 0 ? `n=${calls.scored6h}` : "too early"}
        />
        <Tile
          label="Median at 24h"
          value={mult(calls.median24hX)}
          sub={calls.scored24h > 0 ? `n=${calls.scored24h}` : "too early"}
        />
        <Tile
          label="Time to peak"
          value={minutes(calls.medianMinutesToPeakX)}
          sub="winners"
        />
        <Tile
          label="Winner drawdown"
          value={mult(calls.medianWinnerDrawdownX)}
          sub="worst dip"
        />
      </div>

      <div className="mt-3 overflow-x-auto">
        <table className="w-full min-w-[760px] border-separate border-spacing-y-1 text-left">
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
              <th scope="col" className="px-3 pb-1 text-right font-medium whitespace-nowrap" title="Median minutes from firing to the peak, among winners — how long a reader had to act">
                Peak in
              </th>
              <th scope="col" className="px-3 pb-1 text-right font-medium whitespace-nowrap" title="Median multiple 24 hours after firing, over every scored call including the ones that died">
                24h
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

              return (
                <tr key={row.tier} className="align-middle">
                  <th scope="row" className="w-24 pr-3 text-xs font-medium whitespace-nowrap text-neutral-300">
                    {row.tier} wallets
                  </th>

                  <td className="w-full pr-3">
                    <div className="flex items-center gap-2">
                      <Bar fraction={row.hits2xPerDay / scale} lead={isBest} />
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
                  <td className="tnum px-3 text-right text-xs text-neutral-400">{minutes(row.medianMinutesToPeakX)}</td>
                  <td className="tnum px-3 text-right text-xs text-neutral-400">
                    {row.scored24h > 0 ? mult(row.median24hX) : <span className="text-neutral-600">—</span>}
                  </td>
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
        worked. <span className="text-neutral-400">Peak in</span> is how long the winners took to
        get there, which is the difference between a tradeable call and a screenshot.{" "}
        <span className="text-neutral-400">24h</span> is the median over every scored call, losers
        included, and is the closest thing here to what holding would actually have paid.{" "}
        <span className="text-neutral-400">Scored</span> counts calls old enough to have an observed
        peak, out of all that fired. The headline figures count calls, not escalation steps: a token
        that goes 2 → 6 wallets is one call, not five. Rates are per day over the period actually
        covered, floored at one day, so a feed only hours old reads as a running total rather than
        an extrapolation.
      </p>

      {dimensions.length > 0 ? (
        <div className="mt-5 border-t border-neutral-800/60 pt-4">
          <h3 className="text-xs font-semibold text-neutral-300">Where the edge is</h3>
          <p className="mt-1 text-[11px] leading-relaxed text-neutral-500">
            The tier table answers which escalation step is worth reading. It cannot answer whether a
            call at $15K beats one at $150K, or whether a thirty-second burst beats an hour of
            accumulation — and those are the levers left once the tiers are set. Every cut below is
            taken from the <span className="text-neutral-400">first</span> announced step, so it
            reads as what was knowable when the message went out. The one exception is labelled.
          </p>

          <div className="mt-3 grid gap-4 lg:grid-cols-2">
            {dimensions.map((dim) => {
              const eligible = dim.rows.filter((r) => r.scored >= MIN_CONFIDENT_SAMPLE);
              const lead = eligible.reduce<AlertCut | null>(
                (b, r) =>
                  b === null || (r.hitRate2x ?? 0) > (b.hitRate2x ?? 0) ? r : b,
                null
              );
              const dimScale = Math.max(...dim.rows.map((r) => r.hitRate2x ?? 0), 0.01);

              return (
                <div key={dim.name}>
                  <div className="text-[10px] uppercase tracking-wider text-neutral-500">
                    {dim.name}
                  </div>
                  <table className="mt-1 w-full border-separate border-spacing-y-1 text-left">
                    <thead>
                      <tr className="text-[10px] uppercase tracking-wider text-neutral-600">
                        <th scope="col" className="pb-0.5 font-medium">Bucket</th>
                        <th scope="col" className="pb-0.5 font-medium">Hit rate (2x+)</th>
                        <th
                          scope="col"
                          className="px-2 pb-0.5 text-right font-medium whitespace-nowrap"
                          title="Share of scored calls that ended below half the cap they fired at"
                        >
                          Rugged
                        </th>
                        <th scope="col" className="px-2 pb-0.5 text-right font-medium whitespace-nowrap">
                          Winner
                        </th>
                        <th scope="col" className="pl-2 pb-0.5 text-right font-medium whitespace-nowrap">
                          Calls
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {dim.rows.map((row) => {
                        const isLead = lead?.bucket === row.bucket;
                        const thin = row.scored < MIN_CONFIDENT_SAMPLE;
                        return (
                          <tr key={row.bucket} className="align-middle">
                            <th
                              scope="row"
                              className="w-28 pr-2 text-xs font-normal whitespace-nowrap text-neutral-400"
                            >
                              {row.bucket}
                            </th>
                            <td className="w-full pr-2">
                              <div className="flex items-center gap-2">
                                <Bar fraction={(row.hitRate2x ?? 0) / dimScale} lead={isLead} />
                                <span
                                  className={`tnum w-9 shrink-0 text-xs font-semibold ${
                                    isLead ? "text-blue-300" : "text-neutral-300"
                                  }`}
                                >
                                  {pct(row.hitRate2x)}
                                </span>
                              </div>
                            </td>
                            {/* Status colour, and it earns it: this column means
                                bad, the header names it, so the tint is never
                                the only thing carrying the meaning. */}
                            <td
                              className={`tnum px-2 text-right text-xs ${
                                (row.rugRate ?? 0) >= 0.4 ? "text-rose-400/90" : "text-neutral-500"
                              }`}
                            >
                              {pct(row.rugRate)}
                            </td>
                            <td className="tnum px-2 text-right text-xs text-neutral-400">
                              {mult(row.medianWinnerPeakX)}
                            </td>
                            <td className="tnum pl-2 text-right text-xs whitespace-nowrap text-neutral-500">
                              {row.calls}
                              {thin ? <span className="ml-1 text-neutral-600">·thin</span> : null}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              );
            })}
          </div>

          <p className="mt-3 text-[11px] leading-relaxed text-neutral-500">
            <span className="text-neutral-400">Rugged</span> is here because a cut can be worth
            making for removing losers rather than for finding winners, and a hit rate cannot show
            that. Buckets under {MIN_CONFIDENT_SAMPLE} scored calls are marked{" "}
            <span className="text-neutral-400">·thin</span> and never take the accent.
          </p>
        </div>
      ) : null}

      {removed.length > 0 ? (
        <div className="mt-5 border-t border-neutral-800/60 pt-4">
          <h3 className="text-xs font-semibold text-neutral-300">What the filters removed</h3>
          <p className="mt-1 text-[11px] leading-relaxed text-neutral-500">
            Counted in steps, not calls, because the unit a filter removes is a message.{" "}
            <span className="text-neutral-400">Best</span> is the column that matters: a suppressed
            step that turns out to have been good is the only evidence a knob is set wrong, and it
            has to be visible to count as evidence.
          </p>

          <div className="mt-2 overflow-x-auto">
            <table className="w-full min-w-[420px] border-separate border-spacing-y-1 text-left">
              <thead>
                <tr className="text-[10px] uppercase tracking-wider text-neutral-500">
                  <th scope="col" className="pb-1 font-medium">Filter</th>
                  <th scope="col" className="px-3 pb-1 text-right font-medium">Steps</th>
                  <th scope="col" className="px-3 pb-1 text-right font-medium whitespace-nowrap">Share</th>
                  <th scope="col" className="px-3 pb-1 text-right font-medium whitespace-nowrap" title="Suppressed steps that went on to reach 2x — every one of these is a message a reader did not get">
                    Missed 2x
                  </th>
                  <th scope="col" className="pl-3 pb-1 text-right font-medium whitespace-nowrap">Best</th>
                </tr>
              </thead>
              <tbody>
                {posted ? (
                  <tr className="align-middle">
                    <th scope="row" className="pr-3 text-xs font-medium whitespace-nowrap text-neutral-300">
                      Posted
                    </th>
                    <td className="tnum px-3 text-right text-xs text-neutral-300">{posted.steps}</td>
                    <td className="tnum px-3 text-right text-xs text-neutral-500">—</td>
                    <td className="tnum px-3 text-right text-xs text-blue-300">{posted.hits2x}</td>
                    <td className="tnum pl-3 text-right text-xs text-neutral-300">
                      {mult(posted.bestPeakX)}
                    </td>
                  </tr>
                ) : null}
                {removed.map((row) => {
                  const total = suppression.reduce((sum, r) => sum + r.steps, 0);
                  return (
                    <tr key={row.reason} className="align-middle">
                      <th scope="row" className="pr-3 text-xs font-normal whitespace-nowrap text-neutral-400">
                        {row.reason}
                      </th>
                      <td className="tnum px-3 text-right text-xs text-neutral-400">{row.steps}</td>
                      <td className="tnum px-3 text-right text-xs text-neutral-500">
                        {total > 0 ? pct(row.steps / total) : "—"}
                      </td>
                      {/* Rose only when a knob actually cost a good call. */}
                      <td
                        className={`tnum px-3 text-right text-xs ${
                          row.hits2x > 0 ? "font-semibold text-rose-400" : "text-neutral-500"
                        }`}
                      >
                        {row.scored === 0 ? (
                          <span className="text-neutral-600">n/a</span>
                        ) : (
                          row.hits2x
                        )}
                      </td>
                      <td className="tnum pl-3 text-right text-xs text-neutral-400">
                        {row.scored === 0 ? (
                          <span className="text-neutral-600">n/a</span>
                        ) : (
                          mult(row.bestPeakX)
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <p className="mt-3 text-[11px] leading-relaxed text-neutral-500">
            <span className="text-neutral-400">n/a</span> means the step was never tracked, so there
            is no peak to score it against. That is true by design for the band and for superseded
            steps — an out-of-band call is out of the record entirely, and a superseded step is the
            lower rung claimed in the same instant as the tier that actually fired. The knobs that
            suppress a step but keep tracking it — min tier, min cap, mostly-sold — are the ones this
            table can hold to account.
          </p>
        </div>
      ) : null}
    </section>
  );
}
