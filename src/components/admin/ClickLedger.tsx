"use client";

import { formatCompactNumber, shortenAddress } from "@/lib/format";
import type { LinkClickStats } from "@/lib/db/linkClicks";

/**
 * How much outbound traffic the alerts and the feed actually drive.
 *
 * A venue's own referral dashboard cannot answer this. It shows the conversions
 * that landed on that one venue and nothing about the taps that went elsewhere,
 * so "does the channel or the site send more people" and "which venue do readers
 * actually use" were both unanswerable — including the case that matters most,
 * a venue nobody taps taking up a button slot.
 *
 * **Telegram and the site are separate columns at every level.** A combined
 * total cannot tell a working channel from a working website, which is the whole
 * reason this exists.
 *
 * Clicks, then distinct visitors. Forty taps from one person is not reach, and
 * without the second column the first cannot be read.
 */

/** Venue slugs are lowercase asset names; these are the display forms. */
const VENUE_LABELS: Record<string, string> = {
  axiom: "Axiom",
  trojan: "Trojan",
  gmgn: "GMGN",
  pumpfun: "pump.fun",
  chart: "Chart (Dexscreener)",
};

function label(venue: string): string {
  return VENUE_LABELS[venue] ?? venue;
}

function num(value: number): string {
  return value === 0 ? "0" : formatCompactNumber(value);
}

export default function ClickLedger({ stats }: { stats: LinkClickStats }) {
  const total24h = stats.totalTelegram24h + stats.totalSite24h;

  return (
    <section className="rounded-xl border border-neutral-800/80 bg-neutral-900/40 p-4 sm:p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold text-neutral-200">Where the clicks go</h2>
        <p className="text-[11px] text-neutral-500">Buy links · last 7 days</p>
      </div>

      {total24h === 0 && stats.venues.length === 0 ? (
        <p className="mt-2 text-xs leading-relaxed text-neutral-500">
          No taps recorded yet. Every buy button in the channel and on the feed goes through{" "}
          <code className="text-neutral-400">/api/go</code>, so this fills in from the first tap
          after the deploy — there is no history before it.
        </p>
      ) : (
        <>
          <div className="mt-3 flex flex-wrap gap-x-8 gap-y-2 border-b border-neutral-800/60 pb-3">
            <Figure label="Clicks 24h" value={num(total24h)} />
            <Figure label="From Telegram" value={num(stats.totalTelegram24h)} />
            <Figure label="From the site" value={num(stats.totalSite24h)} />
            <Figure
              label="People 24h"
              value={num(stats.visitors24h)}
              hint="Distinct visitors, hashed. Repeat taps from one person count once."
            />
          </div>

          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-[520px] border-separate border-spacing-y-1 text-left">
              <thead>
                <tr className="text-[10px] uppercase tracking-wider text-neutral-500">
                  <th scope="col" className="pb-1 font-medium">Venue</th>
                  <th scope="col" className="px-3 pb-1 text-right font-medium whitespace-nowrap">
                    TG 24h
                  </th>
                  <th scope="col" className="px-3 pb-1 text-right font-medium whitespace-nowrap">
                    Site 24h
                  </th>
                  <th scope="col" className="px-3 pb-1 text-right font-medium whitespace-nowrap">
                    TG 7d
                  </th>
                  <th scope="col" className="px-3 pb-1 text-right font-medium whitespace-nowrap">
                    Site 7d
                  </th>
                  <th
                    scope="col"
                    className="pl-3 pb-1 text-right font-medium whitespace-nowrap"
                    title="Distinct visitors over the week"
                  >
                    People 7d
                  </th>
                </tr>
              </thead>
              <tbody>
                {stats.venues.map((v) => (
                  <tr key={v.venue} className="align-middle">
                    <th
                      scope="row"
                      className="pr-3 text-xs font-medium whitespace-nowrap text-neutral-300"
                    >
                      {label(v.venue)}
                    </th>
                    <td className="tnum px-3 text-right text-xs text-neutral-300">
                      {num(v.telegram24h)}
                    </td>
                    <td className="tnum px-3 text-right text-xs text-neutral-300">
                      {num(v.site24h)}
                    </td>
                    <td className="tnum px-3 text-right text-xs text-neutral-400">
                      {num(v.telegram7d)}
                    </td>
                    <td className="tnum px-3 text-right text-xs text-neutral-400">
                      {num(v.site7d)}
                    </td>
                    <td className="tnum pl-3 text-right text-xs text-neutral-400">
                      {num(v.visitors7d)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {stats.tokens.length > 0 ? (
            <div className="mt-4 border-t border-neutral-800/60 pt-3">
              <h3 className="text-[10px] uppercase tracking-wider text-neutral-500">
                Calls people acted on · 24h
              </h3>
              <ul className="mt-2 flex flex-wrap gap-1.5">
                {stats.tokens.map((t) => (
                  <li
                    key={`${t.chain}-${t.tokenAddress}`}
                    className="flex items-center gap-1.5 rounded-md border border-neutral-800 bg-neutral-900/60 px-2 py-1 text-[11px]"
                  >
                    <span className="font-medium text-neutral-200">
                      {t.symbol ? `$${t.symbol.replace(/^\$+/, "")}` : shortenAddress(t.tokenAddress, 4)}
                    </span>
                    <span className="tnum text-neutral-400">{num(t.clicks24h)}</span>
                    <span className="tnum text-neutral-600">/ {num(t.visitors24h)} ppl</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}

function Figure({
  label: text,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <div title={hint}>
      <div className="text-[10px] uppercase tracking-wider text-neutral-500">{text}</div>
      <div className="tnum mt-0.5 text-lg font-semibold text-neutral-100">{value}</div>
    </div>
  );
}
