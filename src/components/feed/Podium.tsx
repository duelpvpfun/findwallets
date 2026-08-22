"use client";

import { memo, useMemo } from "react";
import { CHART_VENUE, trackedLinkUrl } from "@/lib/alerts/config";
import { formatMultiple, formatUsd } from "@/lib/format";
import type { AlertFeedRow, CallCard } from "@/lib/db/alerts";

/**
 * The three best calls of the last 24 hours, ranked.
 *
 * The feed below it is chronological, which is honest and completely fails to
 * answer the first question a stranger has: does any of this work. This answers
 * it in one glance and then gets out of the way — it is deliberately short,
 * because the product is the feed.
 *
 * **Ranked left to right, not a medal podium.** The gold-in-the-middle,
 * emoji-medal version read like a game leaderboard, and what these cards carry
 * is trading data: an entry, a peak, a multiple and where the token is now. So
 * the rank is a numeral, the numbers are tabular and the accent on the best call
 * is a single amber rule rather than a gradient. Reading order carries the rank,
 * which is also the only ordering that survives a one-column phone layout.
 *
 * **It refreshes without a request of its own.** The server renders the real
 * 24-hour top three, and from then on the podium re-derives itself from the
 * rows `FeedTerminal` is already polling every eight seconds. A call that
 * overtakes rank 3 is promoted on the next poll, and a call whose peak grows is
 * re-ranked, because the poll returns the updated peak on the same row. Adding
 * a second endpoint for this would have put a third sequential query on a hot
 * path for information the page already has.
 *
 * The 24-hour window is enforced here rather than trusted from the server
 * render: a tab left open overnight would otherwise keep yesterday's winner on
 * the podium forever.
 */

const WINDOW_MS = 24 * 60 * 60 * 1000;

/** Below this a call is not scored anywhere else either — a $3K cap doubling is
 * one buy, and the podium is the worst possible place for an unearned multiple. */
const MIN_ENTRY_USD = 10_000;

export interface PodiumEntry {
  key: string;
  tokenAddress: string;
  tokenSymbol: string | null;
  tokenImageUrl: string | null;
  entryMcapUsd: number;
  athMcapUsd: number;
  /** Where the token is now, so the peak is never the only number on the card. */
  lastMcapUsd: number | null;
  peakX: number;
  walletCount: number;
  createdAt: string;
}

function fromCard(card: CallCard): PodiumEntry {
  return {
    key: `${card.tokenAddress}-${card.episode}`,
    tokenAddress: card.tokenAddress,
    tokenSymbol: card.tokenSymbol,
    tokenImageUrl: card.tokenImageUrl,
    entryMcapUsd: card.entryMcapUsd,
    athMcapUsd: card.athMcapUsd,
    lastMcapUsd: card.lastMcapUsd,
    peakX: card.peakX,
    walletCount: card.walletCount,
    createdAt: card.createdAt,
  };
}

function fromRow(row: AlertFeedRow): PodiumEntry | null {
  const entry = row.mcapAtAlertUsd;
  const ath = row.athMcapUsd;
  if (!entry || !ath || entry < MIN_ENTRY_USD || ath <= entry) return null;
  return {
    key: `${row.tokenAddress}-${row.episode}`,
    tokenAddress: row.tokenAddress,
    tokenSymbol: row.tokenSymbol,
    tokenImageUrl: row.tokenImageUrl,
    entryMcapUsd: entry,
    athMcapUsd: ath,
    lastMcapUsd: row.lastMcapUsd,
    peakX: ath / entry,
    walletCount: row.walletCount,
    createdAt: row.createdAt,
  };
}

/**
 * Merge the server's 24h top three with whatever the live poll has seen.
 *
 * The poll wins on conflict: it carries the newer peak for a call that is still
 * running, and a stale entry beside a live one is the one thing that would make
 * the podium look broken.
 */
function buildPodium(seed: CallCard[], live: AlertFeedRow[], now: number): PodiumEntry[] {
  const byKey = new Map<string, PodiumEntry>();
  for (const card of seed) {
    const entry = fromCard(card);
    if (entry.entryMcapUsd >= MIN_ENTRY_USD && entry.athMcapUsd > entry.entryMcapUsd) {
      byKey.set(entry.key, entry);
    }
  }
  for (const row of live) {
    const entry = fromRow(row);
    if (entry) byKey.set(entry.key, entry);
  }

  return [...byKey.values()]
    .filter((e) => now - new Date(e.createdAt).getTime() <= WINDOW_MS)
    .sort((a, b) => b.peakX - a.peakX)
    .slice(0, 3);
}

/** How long ago the call fired. Derived from the `now` the parent already has,
 * so it re-reads on every poll without a timer of its own. */
function ago(iso: string, now: number): string {
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h` : `${Math.round(h / 24)}d`;
}

/** The multiple restated as the gain. Two ways of reading the same number, and
 * different people reach for different ones. */
function gain(multiple: number): string {
  const value = (multiple - 1) * 100;
  return `+${Math.round(value).toLocaleString("en-US")}%`;
}

/**
 * One ranked call.
 *
 * `rank` is the position, and the only thing it changes is the accent: the best
 * call gets the amber rule and the larger multiple, the other two are identical
 * to each other. Nothing here animates layout — the entrance is opacity and
 * transform, and it plays per occupant because the parent keys on the call.
 */
const Card = memo(function Card({
  entry,
  rank,
  now,
}: {
  entry: PodiumEntry;
  rank: 0 | 1 | 2;
  now: number;
}) {
  const best = rank === 0;
  const ticker = (entry.tokenSymbol || "?").replace(/^\$+/, "");

  return (
    <a
      // Through `/api/go` like every other outbound link, so a tap on the
      // leaderboard is counted the same way as a tap on a row.
      href={trackedLinkUrl({
        venue: CHART_VENUE,
        chain: "solana",
        address: entry.tokenAddress,
        source: "feed",
      })}
      target="_blank"
      rel="noopener noreferrer"
      className={`podium-step group relative flex flex-col overflow-hidden rounded-lg border bg-neutral-900/40 px-2.5 py-2 transition-colors sm:px-3 sm:py-2.5 ${
        best
          ? "border-amber-500/25 hover:border-amber-500/50"
          : "border-neutral-800 hover:border-neutral-700"
      }`}
    >
      {/* The whole accent for rank 1. A gradient wash here read as decoration;
          a rule reads as a mark. */}
      <span
        className={`absolute inset-x-0 top-0 h-px ${
          best ? "bg-amber-400/60" : "bg-neutral-700/50"
        }`}
      />

      <div className="flex items-center gap-1.5">
        <span
          className={`tnum text-[10px] font-semibold leading-none ${
            best ? "text-amber-400/90" : "text-neutral-600"
          }`}
        >
          {String(rank + 1).padStart(2, "0")}
        </span>

        {entry.tokenImageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={entry.tokenImageUrl}
            alt=""
            width={16}
            height={16}
            loading="lazy"
            className="h-4 w-4 shrink-0 rounded-full border border-neutral-800 object-cover"
          />
        ) : null}

        <span className="min-w-0 flex-1 truncate text-xs font-semibold text-neutral-100">
          ${ticker}
        </span>

        <time
          dateTime={entry.createdAt}
          className="tnum shrink-0 text-[10px] text-neutral-600"
          suppressHydrationWarning
        >
          {ago(entry.createdAt, now)}
        </time>
      </div>

      <div className="mt-1.5 flex items-baseline gap-1.5">
        <span
          className={`tnum font-bold leading-none ${
            best ? "text-2xl text-amber-300 sm:text-[28px]" : "text-xl text-emerald-300 sm:text-2xl"
          }`}
        >
          {formatMultiple(entry.peakX)}
        </span>
        <span className="tnum text-[10px] font-medium text-neutral-500">
          {gain(entry.peakX)}
        </span>
      </div>

      {/* The two caps the multiple is the ratio of. Without them it is a claim;
          with them it is checkable against the chart one tap away. And "now"
          keeps the peak from being the only number on the card — almost every
          one of these is below its top by the time it is read. */}
      <div className="mt-1.5 flex items-center justify-between gap-2 border-t border-neutral-800/70 pt-1.5">
        <span className="tnum whitespace-nowrap text-[10px] text-neutral-500">
          {formatUsd(entry.entryMcapUsd)}
          <span className="text-neutral-700"> → </span>
          {formatUsd(entry.athMcapUsd)}
        </span>
        <span className="tnum shrink-0 whitespace-nowrap text-[10px] text-neutral-600">
          {entry.lastMcapUsd ? `now ${formatUsd(entry.lastMcapUsd)}` : `${entry.walletCount}w`}
        </span>
      </div>
    </a>
  );
});

export default function Podium({
  seed,
  live,
  now,
}: {
  seed: CallCard[];
  live: AlertFeedRow[];
  now: number;
}) {
  const top = useMemo(() => buildPodium(seed, live, now), [seed, live, now]);

  // Nothing has traded above its entry in 24 hours. Rendering an empty frame
  // would be worse than rendering nothing — the feed is the product and it is
  // right underneath.
  if (top.length === 0) return null;

  return (
    <section aria-label="Best calls of the last 24 hours" className="mb-3">
      <div className="mb-1.5 flex items-baseline justify-between gap-2 px-0.5">
        <h2 className="text-[11px] font-semibold uppercase tracking-wider text-neutral-400">
          Top calls
          <span className="ml-1.5 font-normal text-neutral-600">24h</span>
        </h2>
        <span className="truncate text-[10px] text-neutral-600">
          peak vs. the cap we called it at
        </span>
      </div>

      {/* One column on a phone, three across from `sm`. The rank is carried by
          reading order, so the layout can reflow without losing it. */}
      <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-3 sm:gap-2">
        {top.map((entry, i) => (
          <Card key={entry.key} entry={entry} rank={i as 0 | 1 | 2} now={now} />
        ))}
      </div>
    </section>
  );
}
