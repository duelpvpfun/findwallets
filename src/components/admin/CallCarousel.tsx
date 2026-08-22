"use client";

import { memo, useCallback, useEffect, useRef, useState } from "react";
import { formatMultiple, formatUsd, shortenAddress } from "@/lib/format";
import { useReducedMotion } from "@/lib/useReducedMotion";
import type { CallCard } from "@/lib/db/alerts";

/**
 * Every scored call as a card, best multiple first, scrolled horizontally.
 *
 * The tables above answer "which knob should move". This answers the question
 * that comes straight after and that no aggregate can: *what did that call
 * actually look like*. A 23.6x in a hit-rate column is a number; the same call
 * as a card is a contract you can paste into a chart, an entry cap, a peak, how
 * far it escalated and how long the reader had — which is the only way to tell
 * a real call from an artefact of thin liquidity.
 *
 * Operator-only, and it shows the FULL contract address. The masking in
 * `fetchAlertFeed` is a business boundary on the public read; here it would
 * just stop the owner checking his own call against a chart.
 *
 * A carousel rather than a grid because the ordering carries meaning. Ranked
 * best to worst, left to right, the position of a card IS a fact about it, and
 * a wrapping grid throws that away at every breakpoint.
 */

/** Cards wide enough to hold a contract address without wrapping it. */
const CARD_WIDTH_PX = 300;
const GAP_PX = 12;

/** How much one arrow press moves. Just under a full viewport, so the card at
 * the edge stays partly visible and the eye keeps its place. */
const PAGE_FRACTION = 0.85;

function pct(multiple: number): string {
  const value = (multiple - 1) * 100;
  const rounded = Math.abs(value) >= 100 ? Math.round(value) : Number(value.toFixed(0));
  return `${value >= 0 ? "+" : ""}${rounded.toLocaleString("en-US")}%`;
}

/** "42m", "3h 10m". The question is "how long did a reader have to act". */
function minutes(value: number | null): string {
  if (value === null) return "—";
  if (value < 1) return `${Math.max(1, Math.round(value * 60))}s`;
  if (value < 60) return `${Math.round(value)}m`;
  const h = Math.floor(value / 60);
  const rem = Math.round(value % 60);
  return rem === 0 ? `${h}h` : `${h}h ${rem}m`;
}

function ago(iso: string, now: number): string {
  const hours = (now - new Date(iso).getTime()) / 3_600_000;
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))}m ago`;
  if (hours < 24) return `${Math.round(hours)}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/**
 * Colour carries one thing only: did this call work.
 *
 * Three states, not a gradient. Green at 2x is the same bar the scoreboard
 * counts a hit at, so the card and the table can never disagree about what
 * "worked" means; red below 1x is a call that never traded above where it was
 * announced.
 */
function toneFor(peakX: number): { text: string; ring: string; chip: string } {
  if (peakX >= 2) {
    return {
      text: "text-emerald-300",
      ring: "border-emerald-500/30",
      chip: "bg-emerald-500/10 text-emerald-300",
    };
  }
  if (peakX >= 1) {
    return {
      text: "text-neutral-100",
      ring: "border-neutral-800",
      chip: "bg-neutral-800/70 text-neutral-300",
    };
  }
  return {
    text: "text-rose-300",
    ring: "border-rose-500/25",
    chip: "bg-rose-500/10 text-rose-300",
  };
}

/** One labelled figure. Two per row inside a card. */
function Stat({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-neutral-500">{label}</div>
      <div className={`tnum text-sm font-medium ${tone ?? "text-neutral-200"}`}>{value}</div>
    </div>
  );
}

/**
 * The contract, and one tap to copy it.
 *
 * This is the whole reason the card beats the table row: the operator is
 * checking a call, and checking a call starts with pasting its address
 * somewhere. Copying happens on the client, so the address never leaves the
 * page to get onto the clipboard.
 */
const CopyAddress = memo(function CopyAddress({ address }: { address: string }) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1400);
    return () => clearTimeout(timer);
  }, [copied]);

  return (
    <button
      type="button"
      onClick={() => {
        navigator.clipboard?.writeText(address).then(
          () => setCopied(true),
          // A clipboard the browser refuses is not worth an error state; the
          // address is on screen and can be selected by hand.
          () => undefined
        );
      }}
      title={address}
      className="tnum flex w-full items-center justify-between gap-2 rounded-md border border-neutral-800 bg-neutral-950/60 px-2 py-1.5 text-left text-[11px] text-neutral-400 transition-colors hover:border-neutral-700 hover:text-neutral-200"
    >
      <span className="truncate">{shortenAddress(address, 6)}</span>
      <span className={copied ? "text-emerald-400" : "text-neutral-600"}>
        {copied ? "copied" : "copy"}
      </span>
    </button>
  );
});

const Card = memo(function Card({ call, rank, now }: { call: CallCard; rank: number; now: number }) {
  const tone = toneFor(call.peakX);
  const ticker = (call.tokenSymbol || "?").replace(/^\$+/, "");

  return (
    <article
      className={`flex w-[300px] shrink-0 snap-start flex-col gap-3 rounded-xl border bg-neutral-900/50 p-4 ${tone.ring}`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="tnum text-[10px] text-neutral-600">#{rank}</span>
            <a
              href={`https://dexscreener.com/solana/${call.tokenAddress}`}
              target="_blank"
              rel="noreferrer"
              className="truncate text-sm font-semibold text-neutral-100 hover:text-blue-300"
            >
              ${ticker}
            </a>
          </div>
          <div className="mt-0.5 truncate text-[11px] text-neutral-500">
            {ago(call.createdAt, now)}
            {call.deliveredSteps === 0 ? (
              // A call held back from Telegram that went on to run is the only
              // evidence a suppression rule is pointed the wrong way, so it is
              // in here and marked rather than filtered out.
              <span className="ml-1.5 rounded bg-amber-500/10 px-1 py-px text-amber-300">
                not sent
              </span>
            ) : null}
          </div>
        </div>
        <div className="text-right">
          <div className={`tnum text-2xl font-semibold leading-none ${tone.text}`}>
            {formatMultiple(call.peakX)}
          </div>
          <div className={`tnum mt-1 inline-block rounded px-1.5 py-px text-[10px] ${tone.chip}`}>
            {pct(call.peakX)}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-x-3 gap-y-2 border-t border-neutral-800/80 pt-3">
        <Stat label="Called at" value={formatUsd(call.entryMcapUsd)} />
        <Stat label="Peak" value={formatUsd(call.athMcapUsd)} tone={tone.text} />
        <Stat label="Now" value={call.lastMcapUsd ? formatUsd(call.lastMcapUsd) : "—"} />
        <Stat
          label="Low"
          value={call.drawdownX === null ? "—" : formatMultiple(call.drawdownX)}
          tone={call.drawdownX !== null && call.drawdownX < 0.5 ? "text-rose-300" : undefined}
        />
        <Stat label="Peak in" value={minutes(call.minutesToPeak)} />
        <Stat
          label="Wallets"
          value={
            call.firstTier === call.peakTier
              ? `${call.walletCount}`
              : `${call.firstTier} → ${call.peakTier}`
          }
        />
      </div>

      <CopyAddress address={call.tokenAddress} />
    </article>
  );
});

/**
 * `now` comes from the dashboard rather than a clock of its own. One clock for
 * the page means the carousel and the tables above it can never disagree about
 * how old something is, and it inherits the dashboard's 60s refresh for free.
 */
export default function CallCarousel({ calls, now }: { calls: CallCard[]; now: number }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const reducedMotion = useReducedMotion();
  const [atStart, setAtStart] = useState(true);
  const [atEnd, setAtEnd] = useState(false);

  const sync = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    setAtStart(el.scrollLeft <= 1);
    // A pixel of slack: fractional widths mean scrollLeft rarely lands exactly
    // on the maximum, which would leave the right arrow enabled forever.
    setAtEnd(el.scrollLeft + el.clientWidth >= el.scrollWidth - 1);
  }, []);

  useEffect(() => {
    sync();
    const el = scrollRef.current;
    if (!el) return;
    const observer = new ResizeObserver(sync);
    observer.observe(el);
    return () => observer.disconnect();
  }, [sync, calls.length]);

  const page = useCallback(
    (direction: -1 | 1) => {
      const el = scrollRef.current;
      if (!el) return;
      const step = Math.max(CARD_WIDTH_PX + GAP_PX, el.clientWidth * PAGE_FRACTION);
      // Smooth scrolling is an animation, so it obeys the same rule as every
      // other one here: off when the reader asked for less motion.
      el.scrollBy({ left: direction * step, behavior: reducedMotion ? "auto" : "smooth" });
    },
    [reducedMotion]
  );

  if (calls.length === 0) {
    return (
      <section className="rounded-xl border border-neutral-800/80 bg-neutral-900/40 p-5">
        <h2 className="text-sm font-semibold text-neutral-300">Calls</h2>
        <p className="mt-2 text-xs text-neutral-500">
          No call has a scored peak yet. A call needs an entry cap over $10K and at least one market
          cap sample after it fired.
        </p>
      </section>
    );
  }

  return (
    <section className="rounded-xl border border-neutral-800/80 bg-neutral-900/40 p-5">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-neutral-300">Calls, best first</h2>
          <p className="mt-0.5 text-xs text-neutral-500">
            {calls.length} scored calls in the last 30 days. Peak over the cap it was called at.
          </p>
        </div>
        <div className="flex gap-1.5">
          <Arrow direction={-1} disabled={atStart} onClick={() => page(-1)} />
          <Arrow direction={1} disabled={atEnd} onClick={() => page(1)} />
        </div>
      </div>

      {/* `overscroll-x-contain` keeps a horizontal flick inside the carousel
          instead of triggering the browser's back gesture mid-scroll. */}
      <div
        ref={scrollRef}
        onScroll={sync}
        className="flex snap-x snap-mandatory gap-3 overflow-x-auto overscroll-x-contain pb-1 [scrollbar-width:thin]"
      >
        {calls.map((call, index) => (
          <Card
            key={`${call.tokenAddress}-${call.episode}`}
            call={call}
            rank={index + 1}
            now={now}
          />
        ))}
      </div>
    </section>
  );
}

function Arrow({
  direction,
  disabled,
  onClick,
}: {
  direction: -1 | 1;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={direction === -1 ? "Previous calls" : "Next calls"}
      className="flex h-7 w-7 items-center justify-center rounded-md border border-neutral-800 text-neutral-400 transition-colors hover:border-neutral-700 hover:text-neutral-100 disabled:cursor-default disabled:opacity-30 disabled:hover:border-neutral-800 disabled:hover:text-neutral-400"
    >
      <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" aria-hidden="true">
        <path
          d={direction === -1 ? "M10 3L5 8l5 5" : "M6 3l5 5-5 5"}
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </button>
  );
}
