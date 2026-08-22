"use client";

import { useEffect, useRef, useState } from "react";
import { CHAIN_LABELS } from "@/lib/chains";
import type { Chain, TokenMeta } from "@/lib/types";
import { useReducedMotion } from "@/lib/useReducedMotion";
import RadarSweep from "./RadarSweep";

/**
 * The scan, while it runs.
 *
 * This is the emotional peak of the product: someone has just paid and is
 * watching results arrive. It used to be pulsing grey bars and a sentence, which
 * reads as "waiting" rather than "working". Now it reads the actual NDJSON
 * progress events — a real count, a real target, and the phase it is in.
 *
 * Skeleton rows are kept underneath, at the real row height, so the table
 * arriving doesn't shift the page.
 */

/** Rows to sketch out below the progress panel. */
const SKELETON_ROWS = 6;

interface ScanProgressProps {
  /** Live from the stream. Null until the first page lands. */
  progress: { found: number; requested: number } | null;
  chain: Chain;
  /** Tier requested, so the target is known before the first progress event. */
  limit: number;
  /**
   * The token being scanned, as soon as the server resolves it. Null for the
   * first moment of a scan. It is here so the panel can name the coin in flight:
   * without it, a second scan showed the previous coin's header until the new
   * result landed, which reads as a stale or cached response.
   */
  token: TokenMeta | null;
}

/**
 * Eases a counter toward its target instead of snapping to it.
 *
 * Pages land in bursts, so the raw count arrives as a few big steps — a Top 100
 * scan would sit on 0 and then jump most of the way in one frame. Interpolating
 * turns the same information into a count that climbs, which is what a reader
 * expects a scan to look like. It only ever moves forward and always finishes on
 * the real number, so nothing is invented: the target is the truth, this is only
 * how it gets there.
 *
 * `useReducedMotion` short-circuits it. A CSS media query cannot stop a
 * requestAnimationFrame loop, so the check has to live in the JS.
 */
function useEasedCount(target: number, enabled: boolean): number {
  const [shown, setShown] = useState(0);
  const frame = useRef<number | null>(null);
  const current = useRef(0);

  useEffect(() => {
    if (!enabled) return;
    // A new scan resets the target to zero. Snap the cursor back rather than
    // counting down — a counter running backwards is not progress.
    if (target < current.current) current.current = target;

    function step() {
      // Approach by a fixed fraction of the remaining gap: fast while far away,
      // settling as it arrives, and it lands exactly rather than oscillating.
      const gap = target - current.current;
      current.current = gap > 0.5 ? current.current + Math.max(0.35, gap * 0.12) : target;
      setShown(Math.floor(current.current));
      if (current.current < target) frame.current = requestAnimationFrame(step);
    }
    frame.current = requestAnimationFrame(step);
    return () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
    };
  }, [target, enabled]);

  // Reduced motion bypasses the state entirely, so nothing has to be written
  // synchronously from the effect to get there.
  return enabled ? Math.min(shown, target) : target;
}

export default function ScanProgress({ progress, chain, limit, token }: ScanProgressProps) {
  const reducedMotion = useReducedMotion();
  const target = Math.min(progress?.found ?? 0, progress?.requested ?? limit);
  const found = useEasedCount(target, !reducedMotion);
  const requested = progress?.requested ?? limit;
  const ratio = requested > 0 ? Math.min(1, found / requested) : 0;

  // Three honest phases. The middle one is where all the time actually goes:
  // BNB Chain and Base page ten wallets at a time.
  // Driven by the real count, not the eased one: a phase label that waits for an
  // animation to finish is describing the animation rather than the scan.
  const phase =
    target === 0
      ? token
        ? "Paging the chain for traders"
        : "Resolving the token"
      : target < requested
      ? "Paging the chain for traders"
      : "Ranking by PNL";

  const slowChainNote =
    chain !== "solana" && limit > 100
      ? `Large ${CHAIN_LABELS[chain]} lookups page ten wallets at a time, so this one takes longer.`
      : null;

  return (
    <div
      className="overflow-hidden rounded-2xl border border-neutral-800/80 bg-neutral-900/40 shadow-xl shadow-black/10"
      role="status"
      aria-live="polite"
    >
      <div className="relative overflow-hidden border-b border-neutral-800/80 px-5 py-6 sm:px-6 sm:py-7">
        {/* The sweep sits behind the numbers, bleeding off the right edge, so it
            reads as depth rather than as a spinner competing for attention. */}
        <div className="pointer-events-none absolute -right-20 -top-24 opacity-60 sm:-right-10">
          <RadarSweep size={260} />
        </div>

        <div className="relative">
          <div className="flex items-center gap-2">
            <span className="relative flex h-1.5 w-1.5">
              {!reducedMotion && (
                <span className="absolute inset-0 animate-ping rounded-full bg-blue-400/70" />
              )}
              <span className="relative h-1.5 w-1.5 rounded-full bg-blue-400" />
            </span>
            <span className="text-[11px] font-medium uppercase tracking-wider text-blue-300">
              Scanning
            </span>
            {/* Names the coin in flight the moment the server resolves it. The
                old panel was anonymous, so the only thing on screen identifying
                a token was the previous scan's table underneath it. */}
            {token && (
              <span className="flex min-w-0 items-center gap-1.5">
                <span className="text-neutral-700">·</span>
                {token.imageUrl && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={token.imageUrl}
                    alt=""
                    className="h-3.5 w-3.5 shrink-0 rounded-full bg-neutral-800 object-cover"
                  />
                )}
                <span className="truncate text-[11px] font-semibold text-neutral-300">
                  {token.symbol ? `$${token.symbol}` : token.name}
                </span>
              </span>
            )}
          </div>

          <div className="mt-2 flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
            {/* Tabular figures: without them the count reflows on every page
                that lands, and a number that jitters reads as broken. */}
            <span className="tnum text-4xl leading-none font-semibold tracking-tight text-neutral-50">
              {found}
            </span>
            <span className="text-sm text-neutral-500">
              of <span className="tnum text-neutral-400">{requested}</span> wallets found
            </span>
          </div>

          <p className="mt-2 text-[13px] text-neutral-400">{phase}</p>

          <div className="mt-4 h-1 w-full overflow-hidden rounded-full bg-neutral-800/80">
            {found === 0 ? (
              // Nothing has landed yet, so there is no honest percentage to show.
              // A drifting sliver says "working" without claiming progress.
              <div className="h-full w-1/3 rounded-full bg-gradient-to-r from-transparent via-blue-500 to-transparent animate-progress-drift" />
            ) : (
              <div
                className="h-full rounded-full bg-gradient-to-r from-blue-500 to-blue-400 transition-[width] duration-300 ease-out"
                style={{ width: `${Math.max(3, ratio * 100)}%` }}
              />
            )}
          </div>

          {slowChainNote && (
            <p className="mt-3 text-[11px] leading-relaxed text-neutral-500">{slowChainNote}</p>
          )}
        </div>
      </div>

      {/* Placeholder rows at the real row height, so nothing jumps when the
          table replaces this. Not animated per-row: at Top 500 the table that
          follows is the render budget, and a shimmer here buys nothing. */}
      <div className="divide-y divide-neutral-900/70">
        {Array.from({ length: SKELETON_ROWS }, (_, i) => (
          <div
            key={i}
            className="flex items-center gap-3 px-4 py-4 sm:px-5"
            // Fading each row a little further out gives the list a horizon
            // instead of six identical grey bars.
            style={{ opacity: 1 - i * 0.13 }}
          >
            <div className="h-3.5 w-3.5 shrink-0 rounded bg-neutral-800" />
            <div className="h-3.5 w-5 shrink-0 rounded bg-neutral-800" />
            <div className="h-3.5 flex-1 rounded bg-neutral-800/80" />
            <div className="hidden h-3.5 w-14 rounded bg-neutral-800/60 sm:block" />
            <div className="h-3.5 w-20 shrink-0 rounded bg-neutral-800" />
          </div>
        ))}
      </div>
    </div>
  );
}
