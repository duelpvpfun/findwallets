"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import RadarSweep from "@/components/RadarSweep";
import { useReducedMotion } from "@/lib/useReducedMotion";
import type { AlertFeedRow } from "@/lib/db/alerts";
import FeedRow from "./FeedRow";

/**
 * The live feed.
 *
 * Polled, not streamed. A websocket or SSE connection per viewer is a cost that
 * scales with the audience we are trying to grow, and calls arrive every few
 * minutes at most — eight seconds of latency is imperceptible against that, and
 * costs one indexed read.
 *
 * Filtering happens on the client, over rows already fetched. A round trip per
 * filter change would feel worse and cost more, and the page holds at most a
 * hundred rows.
 */

const POLL_MS = 8_000;

/** How long a newly arrived row stays highlighted. Long enough to catch the eye
 * on a page someone is not staring at, short enough that a busy minute does not
 * leave the whole feed lit up. */
const FRESH_MS = 20_000;

const MIN_WALLET_OPTIONS = [0, 3, 4, 6, 10] as const;

type CapBand = "any" | "micro" | "small" | "mid" | "large";
type Status = "any" | "up" | "down";

const CAP_BANDS: Array<{ id: CapBand; label: string; test: (mcap: number | null) => boolean }> = [
  { id: "any", label: "Any cap", test: () => true },
  { id: "micro", label: "< $100K", test: (m) => m !== null && m < 100_000 },
  { id: "small", label: "$100K–1M", test: (m) => m !== null && m >= 100_000 && m < 1_000_000 },
  { id: "mid", label: "$1M–10M", test: (m) => m !== null && m >= 1_000_000 && m < 10_000_000 },
  { id: "large", label: "> $10M", test: (m) => m !== null && m >= 10_000_000 },
];

interface Props {
  initialAlerts: AlertFeedRow[];
  trackedWallets: number;
}

export default function FeedTerminal({ initialAlerts, trackedWallets }: Props) {
  const [alerts, setAlerts] = useState(initialAlerts);
  const [live, setLive] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [exhausted, setExhausted] = useState(initialAlerts.length === 0);

  const [minWallets, setMinWallets] = useState<number>(0);
  const [band, setBand] = useState<CapBand>("any");
  const [status, setStatus] = useState<Status>("any");
  const [query, setQuery] = useState("");

  const reducedMotion = useReducedMotion();

  // Ids seen on a previous poll. Anything not in here is new and gets the flash.
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
        // Clearing per batch rather than on a single global timer, so a row that
        // arrives during another row's highlight still gets its full moment.
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

  useEffect(() => {
    if (!live) return;
    const timer = setInterval(refresh, POLL_MS);
    // Returning to a backgrounded tab should not show a stale feed.
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
      // Leave the button so it can be retried.
    } finally {
      setLoadingMore(false);
    }
  }, [alerts, loadingMore]);

  const visible = useMemo(() => {
    const capTest = CAP_BANDS.find((b) => b.id === band)?.test ?? (() => true);
    const needle = query.trim().toLowerCase();
    return alerts.filter((a) => {
      if (a.peakTier < minWallets) return false;
      if (!capTest(a.mcapAtAlertUsd)) return false;
      if (status !== "any") {
        const base = a.mcapAtAlertUsd;
        const nowX = base && base > 0 && a.lastMcapUsd ? a.lastMcapUsd / base : null;
        if (nowX === null) return false;
        if (status === "up" && nowX < 1) return false;
        if (status === "down" && nowX >= 1) return false;
      }
      if (needle) {
        const hay = `${a.tokenSymbol ?? ""} ${a.tokenName ?? ""} ${a.tokenAddress}`.toLowerCase();
        if (!hay.includes(needle)) return false;
      }
      return true;
    });
  }, [alerts, minWallets, band, status, query]);

  const filtered = visible.length !== alerts.length;

  return (
    <div>
      <header className="relative overflow-hidden rounded-t-xl border border-b-0 border-neutral-800/80 bg-neutral-900/40 px-3 py-3">
        {/* The scanning metaphor, same as the wallet finder. Behind the title at
            low opacity so it reads as depth, not decoration. */}
        <div className="pointer-events-none absolute -top-24 -right-16 opacity-[0.28]">
          <RadarSweep size={200} />
        </div>

        <div className="relative flex flex-wrap items-center gap-x-3 gap-y-2">
          <h1 className="flex items-center gap-2 text-sm font-semibold text-neutral-50">
            <span
              className={`h-1.5 w-1.5 rounded-full ${
                live ? "bg-emerald-400" : "bg-neutral-600"
              } ${live && !reducedMotion ? "animate-live-pulse" : ""}`}
            />
            Live feed
          </h1>
          <span className="tnum text-[11px] text-neutral-500">
            {trackedWallets.toLocaleString()} wallets tracked
          </span>
          <button
            type="button"
            onClick={() => setLive((v) => !v)}
            className="ml-auto rounded-md border border-neutral-800 bg-neutral-900 px-2 py-1 text-[11px] font-medium text-neutral-400 transition-colors hover:border-neutral-700 hover:text-neutral-200"
          >
            {live ? "Pause" : "Resume"}
          </button>
        </div>

        <div className="relative mt-3 flex flex-wrap items-center gap-1.5">
          <Segmented
            options={MIN_WALLET_OPTIONS.map((n) => ({
              id: String(n),
              label: n === 0 ? "All" : `${n}w+`,
            }))}
            value={String(minWallets)}
            onChange={(v) => setMinWallets(Number(v))}
          />
          <Segmented
            options={CAP_BANDS.map((b) => ({ id: b.id, label: b.label }))}
            value={band}
            onChange={(v) => setBand(v as CapBand)}
          />
          <Segmented
            options={[
              { id: "any", label: "All" },
              { id: "up", label: "Up" },
              { id: "down", label: "Down" },
            ]}
            value={status}
            onChange={(v) => setStatus(v as Status)}
          />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Ticker or contract"
            aria-label="Filter by ticker or contract"
            className="min-w-0 flex-1 rounded-md border border-neutral-800 bg-neutral-900 px-2 py-1 text-[11px] text-neutral-200 placeholder:text-neutral-600 focus:border-neutral-700 focus:outline-none"
          />
        </div>
      </header>

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

      {alerts.length > 0 && !exhausted && !filtered ? (
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

/** A row of mutually exclusive filter chips. */
function Segmented({
  options,
  value,
  onChange,
}: {
  options: Array<{ id: string; label: string }>;
  value: string;
  onChange: (id: string) => void;
}) {
  return (
    <div className="flex shrink-0 overflow-hidden rounded-md border border-neutral-800">
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          onClick={() => onChange(o.id)}
          aria-pressed={value === o.id}
          className={`px-2 py-1 text-[11px] font-medium transition-colors ${
            value === o.id
              ? "bg-neutral-800 text-neutral-100"
              : "bg-neutral-900 text-neutral-500 hover:text-neutral-300"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
