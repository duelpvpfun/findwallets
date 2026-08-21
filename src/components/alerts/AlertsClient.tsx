"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { formatCompactNumber, formatMultiple } from "@/lib/format";
import { useReducedMotion } from "@/lib/useReducedMotion";
import type { AlertFeedRow, AlertSummary, TierScore } from "@/lib/db/alerts";
import AlertCard from "./AlertCard";
import TierScoreboard from "./TierScoreboard";

/**
 * The live feed.
 *
 * Server-rendered first so the page is never an empty shell, then polled. A
 * websocket would be the obvious choice and is the wrong one here: alerts
 * arrive a few times an hour, the page is public and free, and a persistent
 * connection per viewer is a cost that scales with an audience we are trying to
 * grow.
 */

const POLL_INTERVAL_MS = 25_000;

interface Props {
  initialAlerts: AlertFeedRow[];
  initialSummary: AlertSummary | null;
  initialScoreboard: TierScore[];
  telegramUrl: string | null;
}

export default function AlertsClient({
  initialAlerts,
  initialSummary,
  initialScoreboard,
  telegramUrl,
}: Props) {
  const [alerts, setAlerts] = useState(initialAlerts);
  const [summary, setSummary] = useState(initialSummary);
  const [scoreboard, setScoreboard] = useState(initialScoreboard);
  const [loadingMore, setLoadingMore] = useState(false);
  const [exhausted, setExhausted] = useState(initialAlerts.length === 0);

  const reducedMotion = useReducedMotion();
  // Re-rendering "2m ago" needs a tick even when nothing new arrived.
  const [, setTick] = useState(0);

  // Kept in a ref so the polling effect doesn't re-subscribe on every refresh.
  const newestId = useRef(initialAlerts[0]?.id ?? 0);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/alerts/feed?limit=40", { cache: "no-store" });
      if (!res.ok) return;
      const data = await res.json();
      if (!Array.isArray(data.alerts)) return;

      setAlerts(data.alerts);
      newestId.current = data.alerts[0]?.id ?? newestId.current;
      if (data.summary) setSummary(data.summary);
      if (Array.isArray(data.scoreboard)) setScoreboard(data.scoreboard);
      if (data.alerts.length > 0) setExhausted(false);
    } catch {
      // A dropped poll is a dropped poll. The next one is 25 seconds away.
    }
  }, []);

  useEffect(() => {
    const poll = setInterval(refresh, POLL_INTERVAL_MS);
    // The relative timestamps go stale on their own; this is the only thing
    // that keeps "2m ago" honest between polls.
    const clock = setInterval(() => setTick((t) => t + 1), 30_000);
    // Coming back to a backgrounded tab should not show a five-minute-old feed.
    const onVisible = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(poll);
      clearInterval(clock);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [refresh]);

  const loadMore = useCallback(async () => {
    const oldest = alerts[alerts.length - 1];
    if (!oldest || loadingMore) return;
    setLoadingMore(true);
    try {
      const res = await fetch(`/api/alerts/feed?before=${oldest.id}&limit=40`, {
        cache: "no-store",
      });
      const data = await res.json();
      const next: AlertFeedRow[] = Array.isArray(data.alerts) ? data.alerts : [];
      if (next.length === 0) setExhausted(true);
      else setAlerts((current) => [...current, ...next]);
    } catch {
      // Leave the button in place so the reader can try again.
    } finally {
      setLoadingMore(false);
    }
  }, [alerts, loadingMore]);

  return (
    <div className="space-y-6">
      <StatRow summary={summary} telegramUrl={telegramUrl} reducedMotion={reducedMotion} />

      <TierScoreboard scores={scoreboard} />

      <section>
        <div className="mb-3 flex items-baseline justify-between gap-3">
          <h2 className="text-sm font-semibold text-neutral-200">Live feed</h2>
          <p className="text-[11px] text-neutral-500">Solana · updates every 25s</p>
        </div>

        {alerts.length === 0 ? (
          <div className="rounded-xl border border-dashed border-neutral-800 bg-neutral-900/20 px-4 py-10 text-center">
            <p className="text-sm text-neutral-300">No alerts yet.</p>
            <p className="mx-auto mt-2 max-w-md text-xs leading-relaxed text-neutral-500">
              The stream is watching every tracked wallet. An alert fires when two of them buy the
              same token within two minutes, three within five, or four within the hour.
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {alerts.map((alert) => (
              <AlertCard key={alert.id} alert={alert} />
            ))}
          </div>
        )}

        {alerts.length > 0 && !exhausted ? (
          <button
            type="button"
            onClick={loadMore}
            disabled={loadingMore}
            className="mt-4 w-full rounded-lg border border-neutral-800 bg-neutral-900/60 px-4 py-2.5 text-xs font-medium text-neutral-300 transition-colors hover:border-neutral-700 hover:text-neutral-50 disabled:opacity-50"
          >
            {loadingMore ? "Loading…" : "Load older alerts"}
          </button>
        ) : null}
      </section>
    </div>
  );
}

/** The headline row. Four figures, no chart — a handful of current values is a
 * KPI row, and a bar chart of four unrelated measures would say less. */
function StatRow({
  summary,
  telegramUrl,
  reducedMotion,
}: {
  summary: AlertSummary | null;
  telegramUrl: string | null;
  reducedMotion: boolean;
}) {
  return (
    <section className="rounded-xl border border-neutral-800/80 bg-neutral-900/40 p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="grid flex-1 grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-4">
          <Stat
            label="Wallets tracked"
            value={summary ? formatCompactNumber(summary.trackedWallets) : "—"}
          />
          <Stat label="Alerts, 24h" value={summary ? String(summary.alerts24h) : "—"} />
          <Stat
            label="Avg peak"
            value={summary?.avgPeakX ? formatMultiple(summary.avgPeakX) : "—"}
            accent
          />
          <Stat
            label="Best call"
            value={summary?.bestPeakX ? formatMultiple(summary.bestPeakX) : "—"}
            accent
          />
        </div>

        {telegramUrl ? (
          <a
            href={telegramUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex shrink-0 items-center gap-2 rounded-lg bg-blue-600 px-3.5 py-2 text-xs font-semibold text-white transition-colors hover:bg-blue-500"
          >
            <span
              // The pulse is decorative; reduced motion resolves it to a plain dot.
              className={`h-1.5 w-1.5 rounded-full bg-white/90 ${
                reducedMotion ? "" : "animate-live-pulse"
              }`}
            />
            Get these on Telegram
          </a>
        ) : null}
      </div>
    </section>
  );
}

function Stat({ label, value, accent = false }: { label: string; value: string; accent?: boolean }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-neutral-500">{label}</div>
      {/* .tnum because these change while somebody is watching them. */}
      <div
        className={`tnum mt-0.5 text-xl font-semibold ${
          accent ? "text-blue-300" : "text-neutral-50"
        }`}
      >
        {value}
      </div>
    </div>
  );
}
