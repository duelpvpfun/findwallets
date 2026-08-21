"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import RadarSweep from "@/components/RadarSweep";
import { useReducedMotion } from "@/lib/useReducedMotion";
import type { AlertFeedRow } from "@/lib/db/alerts";
import FeedRow from "./FeedRow";

/**
 * The live feed.
 *
 * Polled, not streamed. A websocket per viewer is a cost that scales with the
 * audience we are trying to grow, calls arrive every few minutes at most, and
 * eight seconds of latency is imperceptible against that.
 *
 * **Polling pauses while the pointer is over the feed.** Rows reordering under
 * a cursor that is halfway to a buy button is the one way a live feed can
 * actively work against its reader.
 *
 * Filtering is client-side over rows already fetched: a round trip per
 * keystroke would feel worse and cost more, and the page holds at most a
 * hundred rows.
 */

const POLL_MS = 8_000;

/** How long a newly arrived row stays highlighted. Long enough to catch the eye
 * on a page nobody is staring at, short enough that a busy minute does not
 * leave the whole feed lit up. */
const FRESH_MS = 20_000;

interface Props {
  initialAlerts: AlertFeedRow[];
  trackedWallets: number;
}

/** A market cap typed in thousands, e.g. `20` meaning $20K. Empty means "no
 * bound", which is different from zero and has to stay distinguishable. */
function parseThousands(raw: string): number | null {
  if (raw.trim() === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n * 1_000 : null;
}

function parseCount(raw: string): number | null {
  if (raw.trim() === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

export default function FeedTerminal({ initialAlerts, trackedWallets }: Props) {
  const [alerts, setAlerts] = useState(initialAlerts);
  const [paused, setPaused] = useState(false);
  const [hovering, setHovering] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [exhausted, setExhausted] = useState(initialAlerts.length === 0);

  const [minWallets, setMinWallets] = useState("");
  const [maxWallets, setMaxWallets] = useState("");
  const [minCapK, setMinCapK] = useState("");
  const [maxCapK, setMaxCapK] = useState("");
  const [query, setQuery] = useState("");

  const reducedMotion = useReducedMotion();

  const seen = useRef<Set<number>>(new Set(initialAlerts.map((a) => a.id)));
  const [freshIds, setFreshIds] = useState<Set<number>>(new Set());

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/feed?limit=60", { cache: "no-store" });
      if (!res.ok) return;
      const data = await res.json();
      if (!Array.isArray(data.alerts)) return;

      const incoming: AlertFeedRow[] = data.alerts;
      const arrived = incoming.filter((a) => !seen.current.has(a.id)).map((a) => a.id);
      for (const a of incoming) seen.current.add(a.id);

      setAlerts(incoming);
      if (arrived.length > 0) {
        setFreshIds((current) => new Set([...current, ...arrived]));
        // Cleared per batch rather than on one global timer, so a row arriving
        // during another row's highlight still gets its full moment.
        setTimeout(() => {
          setFreshIds((current) => {
            const next = new Set(current);
            for (const id of arrived) next.delete(id);
            return next;
          });
        }, FRESH_MS);
      }
    } catch {
      // A dropped poll is a dropped poll; the next one is eight seconds away.
    }
  }, []);

  const live = !paused && !hovering;

  useEffect(() => {
    if (!live) return;
    const timer = setInterval(refresh, POLL_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [live, refresh]);

  const loadMore = useCallback(async () => {
    const oldest = alerts[alerts.length - 1];
    if (!oldest || loadingMore) return;
    setLoadingMore(true);
    try {
      const res = await fetch(`/api/feed?before=${oldest.id}&limit=60`, { cache: "no-store" });
      const data = await res.json();
      const next: AlertFeedRow[] = Array.isArray(data.alerts) ? data.alerts : [];
      if (next.length === 0) setExhausted(true);
      else {
        for (const a of next) seen.current.add(a.id);
        setAlerts((current) => [...current, ...next]);
      }
    } catch {
      // Leave the button in place so it can be retried.
    } finally {
      setLoadingMore(false);
    }
  }, [alerts, loadingMore]);

  const visible = useMemo(() => {
    const wMin = parseCount(minWallets);
    const wMax = parseCount(maxWallets);
    const cMin = parseThousands(minCapK);
    const cMax = parseThousands(maxCapK);
    const needle = query.trim().toLowerCase();

    return alerts.filter((a) => {
      if (wMin !== null && a.peakTier < wMin) return false;
      if (wMax !== null && a.peakTier > wMax) return false;
      const cap = a.mcapAtAlertUsd;
      // A bound excludes rows with no cap at all: "over $20K" cannot honestly
      // include a row whose cap is unknown.
      if (cMin !== null && (cap === null || cap < cMin)) return false;
      if (cMax !== null && (cap === null || cap > cMax)) return false;
      if (needle) {
        const hay = `${a.tokenSymbol ?? ""} ${a.tokenName ?? ""} ${a.tokenAddress}`.toLowerCase();
        if (!hay.includes(needle)) return false;
      }
      return true;
    });
  }, [alerts, minWallets, maxWallets, minCapK, maxCapK, query]);

  const filtering = visible.length !== alerts.length;
  const anyFilter = [minWallets, maxWallets, minCapK, maxCapK, query].some((v) => v.trim() !== "");

  return (
    <div onMouseEnter={() => setHovering(true)} onMouseLeave={() => setHovering(false)}>
      <header className="relative overflow-hidden rounded-t-xl border border-b-0 border-neutral-800/80 bg-neutral-900/40 px-3 py-3">
        {/* The scanning metaphor, same as the wallet finder. Low opacity so it
            reads as depth rather than decoration. */}
        <div className="pointer-events-none absolute -top-24 -right-16 opacity-[0.28]">
          <RadarSweep size={200} />
        </div>

        <div className="relative flex flex-wrap items-center gap-x-3 gap-y-2">
          <h1 className="flex items-center gap-2 text-sm font-semibold text-neutral-50">
            <span
              className={`h-1.5 w-1.5 rounded-full ${live ? "bg-emerald-400" : "bg-amber-400"} ${
                live && !reducedMotion ? "animate-live-pulse" : ""
              }`}
            />
            Live feed
          </h1>
          <p className="text-[11px] text-neutral-500">
            Tokens several proven wallets bought within minutes of each other ·{" "}
            <span className="tnum">{trackedWallets.toLocaleString()}</span> wallets tracked
          </p>
          <span className="tnum ml-auto text-[11px] text-neutral-600">
            {hovering && !paused ? "paused while hovering" : paused ? "paused" : "live"}
          </span>
          <button
            type="button"
            onClick={() => setPaused((v) => !v)}
            className="rounded-md border border-neutral-800 bg-neutral-900 px-2 py-1 text-[11px] font-medium text-neutral-400 transition-colors hover:border-neutral-700 hover:text-neutral-200"
          >
            {paused ? "Resume" : "Pause"}
          </button>
        </div>

        <div className="relative mt-3">
          <div className="mb-1.5 flex items-baseline gap-2">
            <span className="text-[10px] font-medium uppercase tracking-wider text-neutral-500">
              Filters
            </span>
            {anyFilter ? (
              <button
                type="button"
                onClick={() => {
                  setMinWallets("");
                  setMaxWallets("");
                  setMinCapK("");
                  setMaxCapK("");
                  setQuery("");
                }}
                className="text-[10px] font-medium text-blue-400 hover:text-blue-300"
              >
                Clear
              </button>
            ) : null}
          </div>

          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <RangeInput
              label="Wallets in"
              minValue={minWallets}
              maxValue={maxWallets}
              onMin={setMinWallets}
              onMax={setMaxWallets}
              placeholderMin="2"
              placeholderMax="20"
            />
            <RangeInput
              label="Market cap at call"
              suffix="K"
              minValue={minCapK}
              maxValue={maxCapK}
              onMin={setMinCapK}
              onMax={setMaxCapK}
              placeholderMin="20"
              placeholderMax="1k"
            />
            <label className="flex min-w-[10rem] flex-1 flex-col gap-1">
              <span className="text-[10px] uppercase tracking-wider text-neutral-500">
                Ticker or contract
              </span>
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="e.g. BONK"
                className="rounded-md border border-neutral-800 bg-neutral-900 px-2 py-1 text-[11px] text-neutral-200 placeholder:text-neutral-600 focus:border-neutral-700 focus:outline-none"
              />
            </label>
          </div>
        </div>
      </header>

      {/* Column headers. A dense row of numbers is unreadable without them, and
          three of these columns are ratios against different denominators. */}
      <div className="hidden items-center gap-2 border-x border-neutral-800/80 bg-neutral-900/20 px-3 py-1.5 text-[10px] uppercase tracking-wider text-neutral-600 sm:flex">
        <span className="flex min-w-0 flex-1 items-center gap-x-3">
          <span className="w-[0.6rem] shrink-0" />
          <span className="w-16 shrink-0">Fired</span>
          <span className="w-9 shrink-0 text-center">In</span>
          <span className="w-24 shrink-0">Token</span>
          <span className="w-36 shrink-0">Their record</span>
          <span className="hidden w-12 shrink-0 text-right md:block">Span</span>
          <span className="w-20 shrink-0 text-right">Cap at call</span>
          <span className="w-14 shrink-0 text-right">Peak</span>
          <span className="w-16 shrink-0 text-right">Now</span>
        </span>
        <span className="hidden w-[132px] shrink-0 lg:block">Since</span>
        <span className="shrink-0">Buy</span>
      </div>

      <div className="rounded-b-xl border border-neutral-800/80 bg-neutral-950/60">
        {visible.length === 0 ? (
          <p className="px-3 py-10 text-center text-xs text-neutral-500">
            {alerts.length === 0
              ? "Watching. Nothing has cleared a tier yet."
              : "Nothing matches these filters."}
          </p>
        ) : (
          visible.map((a) => <FeedRow key={a.id} alert={a} fresh={freshIds.has(a.id)} />)
        )}
      </div>

      {alerts.length > 0 && !exhausted && !filtering ? (
        <button
          type="button"
          onClick={loadMore}
          disabled={loadingMore}
          className="mt-3 w-full rounded-lg border border-neutral-800 bg-neutral-900/60 px-4 py-2 text-xs font-medium text-neutral-400 transition-colors hover:border-neutral-700 hover:text-neutral-100 disabled:opacity-50"
        >
          {loadingMore ? "Loading…" : "Older"}
        </button>
      ) : null}
    </div>
  );
}

/** A labelled min/max pair. Typed numbers rather than preset buttons, because
 * the useful bound is whatever the reader is hunting for that day. */
function RangeInput({
  label,
  suffix,
  minValue,
  maxValue,
  onMin,
  onMax,
  placeholderMin,
  placeholderMax,
}: {
  label: string;
  suffix?: string;
  minValue: string;
  maxValue: string;
  onMin: (v: string) => void;
  onMax: (v: string) => void;
  placeholderMin: string;
  placeholderMax: string;
}) {
  const box =
    "tnum w-20 rounded-md border border-neutral-800 bg-neutral-900 px-2 py-1 text-[11px] text-neutral-200 placeholder:text-neutral-600 focus:border-neutral-700 focus:outline-none";
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[10px] uppercase tracking-wider text-neutral-500">
        {label}
        {suffix ? <span className="text-neutral-600"> ({suffix})</span> : null}
      </span>
      <div className="flex items-center gap-1">
        <input
          type="number"
          min={0}
          inputMode="numeric"
          value={minValue}
          onChange={(e) => onMin(e.target.value)}
          placeholder={`min ${placeholderMin}`}
          aria-label={`${label} minimum`}
          className={box}
        />
        <span className="text-[11px] text-neutral-600">–</span>
        <input
          type="number"
          min={0}
          inputMode="numeric"
          value={maxValue}
          onChange={(e) => onMax(e.target.value)}
          placeholder={`max ${placeholderMax}`}
          aria-label={`${label} maximum`}
          className={box}
        />
      </div>
    </div>
  );
}
