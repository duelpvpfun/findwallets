"use client";

import { memo, useMemo } from "react";
import { formatMultiple, formatUsd } from "@/lib/format";
import type { AlertFeedRow, CallCard } from "@/lib/db/alerts";

/**
 * The three best calls of the last 24 hours, as a podium.
 *
 * The feed below it is chronological, which is honest and completely fails to
 * answer the first question a stranger has: does any of this work. The podium
 * answers it in one glance and then gets out of the way — it is deliberately
 * short, because the product is the feed.
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
  entryMcapUsd: number;
  athMcapUsd: number;
  peakX: number;
  walletCount: number;
  createdAt: string;
}

function fromCard(card: CallCard): PodiumEntry {
  return {
    key: `${card.tokenAddress}-${card.episode}`,
    tokenAddress: card.tokenAddress,
    tokenSymbol: card.tokenSymbol,
    entryMcapUsd: card.entryMcapUsd,
    athMcapUsd: card.athMcapUsd,
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
    entryMcapUsd: entry,
    athMcapUsd: ath,
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

const MEDALS = ["🥇", "🥈", "🥉"];

/**
 * One step of the podium.
 *
 * `place` is the rank; `height` is the visual weight, which is what makes it a
 * podium rather than three cards in a row. Only padding and type size change —
 * nothing here animates layout.
 */
const Step = memo(function Step({
  entry,
  place,
}: {
  entry: PodiumEntry;
  place: 0 | 1 | 2;
}) {
  const first = place === 0;
  const ticker = (entry.tokenSymbol || "?").replace(/^\$+/, "");

  return (
    <a
      href={`https://dexscreener.com/solana/${entry.tokenAddress}`}
      target="_blank"
      rel="noopener noreferrer"
      // `key` on the parent is the call, so React remounts this when the
      // occupant changes and the entrance animation plays for the new call
      // only — not for every re-rank of the same three.
      className={`podium-step group flex flex-col items-center justify-end rounded-xl border text-center transition-colors ${
        first
          ? "border-amber-500/30 bg-gradient-to-b from-amber-500/[0.07] to-neutral-900/40 px-2 py-3 hover:border-amber-500/50 sm:px-3 sm:py-4"
          : "border-neutral-800 bg-neutral-900/40 px-2 py-2 hover:border-neutral-700 sm:py-2.5"
      }`}
    >
      <div className={first ? "text-base leading-none sm:text-lg" : "text-xs leading-none sm:text-sm"}>
        {MEDALS[place]}
      </div>

      <div
        className={`mt-1 max-w-full truncate font-semibold ${
          first ? "text-sm text-neutral-50 sm:text-base" : "text-[11px] text-neutral-300 sm:text-xs"
        }`}
      >
        ${ticker}
      </div>

      <div
        className={`tnum font-bold leading-none ${
          first
            ? "mt-1.5 text-2xl text-amber-300 sm:text-3xl"
            : "mt-1 text-lg text-emerald-300 sm:text-xl"
        }`}
      >
        {formatMultiple(entry.peakX)}
      </div>

      {/* The two caps the multiple is the ratio of. Without them the number is
          a claim; with them it is checkable against the chart one tap away. */}
      <div
        className={`tnum mt-1 whitespace-nowrap text-neutral-500 ${
          first ? "text-[10px] sm:text-[11px]" : "text-[9px] sm:text-[10px]"
        }`}
      >
        {formatUsd(entry.entryMcapUsd)} → {formatUsd(entry.athMcapUsd)}
      </div>

      {first ? (
        <div className="mt-0.5 text-[10px] text-neutral-600">
          {entry.walletCount} smart wallets in
        </div>
      ) : null}
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

  // Nothing has traded above its entry in 24 hours. Rendering an empty podium
  // frame would be worse than rendering nothing — the feed is the product and
  // it is right underneath.
  if (top.length === 0) return null;

  // Rank 1 in the middle at full height, 2 on the right, 3 on the left, so the
  // eye lands on the best call first. With fewer than three the centre must
  // stay the centre, so the empty slots are held rather than collapsed.
  const [gold, silver, bronze] = top;
  const slots: Array<{ entry: PodiumEntry | undefined; place: 0 | 1 | 2 }> = [
    { entry: bronze, place: 2 },
    { entry: gold, place: 0 },
    { entry: silver, place: 1 },
  ];

  return (
    <section aria-label="Best calls of the last 24 hours" className="mb-3">
      <div className="mb-1.5 flex items-baseline justify-between px-0.5">
        <h2 className="text-[11px] font-semibold uppercase tracking-wider text-neutral-500">
          Best calls · 24h
        </h2>
        <span className="text-[10px] text-neutral-600">peak vs. the cap we called it at</span>
      </div>

      <div className="grid grid-cols-3 items-end gap-1.5 sm:gap-2">
        {slots.map(({ entry, place }) =>
          entry ? (
            <Step key={entry.key} entry={entry} place={place} />
          ) : (
            // Holds the column so rank 1 stays centred on a thin day.
            <div key={`empty-${place}`} aria-hidden="true" />
          )
        )}
      </div>
    </section>
  );
}
