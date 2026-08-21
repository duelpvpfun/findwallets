"use client";

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AdminStats, PaymentRow, TimePoint, UsageRow } from "@/lib/db/adminStats";
import { formatCompactNumber, shortenAddress } from "@/lib/format";

const REFRESH_MS = 60_000;

function usd(value: number): string {
  return `$${value.toFixed(2)}`;
}

function timeAgo(iso: string | null, now: number): string {
  if (!iso) return "—";
  const ms = now - new Date(iso).getTime();
  if (!Number.isFinite(ms)) return "—";
  const mins = Math.floor(ms / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ${mins % 60}m ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ${hours % 24}h ago`;
  return `${Math.floor(days / 30)}mo ago`;
}

function localTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString();
}

const Card = memo(function Card({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub?: string;
}) {
  return (
    <div className="rounded-xl border border-neutral-800 bg-neutral-900/60 p-4">
      <div className="text-[11px] uppercase tracking-wide text-neutral-500">{label}</div>
      <div className="mt-1 text-2xl font-semibold text-neutral-100">{value}</div>
      {sub ? <div className="mt-1 text-xs text-neutral-500">{sub}</div> : null}
    </div>
  );
});

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-8">
      <h2 className="mb-3 text-sm font-semibold text-neutral-300">{title}</h2>
      {children}
    </section>
  );
}

const UsageTable = memo(function UsageTable({ rows }: { rows: UsageRow[] }) {
  if (rows.length === 0) {
    return <p className="text-xs text-neutral-500">No calls recorded in this window.</p>;
  }
  const totalCredits = rows.reduce((sum, r) => sum + r.credits, 0);
  const totalCalls = rows.reduce((sum, r) => sum + r.calls, 0);
  return (
    <div className="overflow-x-auto rounded-xl border border-neutral-800">
      <table className="w-full text-left text-xs">
        <thead className="bg-neutral-900 text-neutral-500">
          <tr>
            <th className="px-3 py-2 font-medium">Provider</th>
            <th className="px-3 py-2 font-medium">Endpoint</th>
            <th className="px-3 py-2 text-right font-medium">Calls</th>
            <th className="px-3 py-2 text-right font-medium">Credits</th>
            <th className="px-3 py-2 text-right font-medium">Errors</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-neutral-800/70">
          {rows.map((r) => (
            <tr key={`${r.provider}-${r.endpoint}`} className="text-neutral-300">
              <td className="px-3 py-2">{r.provider}</td>
              <td className="px-3 py-2 font-mono text-[11px] text-neutral-400">{r.endpoint}</td>
              <td className="px-3 py-2 text-right">{formatCompactNumber(r.calls)}</td>
              <td className="px-3 py-2 text-right">{formatCompactNumber(r.credits)}</td>
              <td className={`px-3 py-2 text-right ${r.errors > 0 ? "text-red-400" : ""}`}>
                {r.errors}
              </td>
            </tr>
          ))}
          <tr className="bg-neutral-900/60 font-medium text-neutral-200">
            <td className="px-3 py-2" colSpan={2}>
              Total
            </td>
            <td className="px-3 py-2 text-right">{formatCompactNumber(totalCalls)}</td>
            <td className="px-3 py-2 text-right">{formatCompactNumber(totalCredits)}</td>
            <td className="px-3 py-2" />
          </tr>
        </tbody>
      </table>
    </div>
  );
});

/** Hourly buckets arrive as UTC ISO strings; rendered in the viewer's zone so
 * the chart lines up with the timestamps in the payments table. */
function bucketLabel(bucket: string, hourly: boolean): string {
  if (!hourly) return bucket;
  const d = new Date(bucket);
  return Number.isNaN(d.getTime())
    ? bucket
    : d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric" });
}

/** Inline sparkline-style bars; avoids pulling in a charting dependency. */
const TrafficBars = memo(function TrafficBars({
  points,
  hourly,
}: {
  points: TimePoint[];
  hourly: boolean;
}) {
  // Labels go through Intl, which is slow enough that doing it per bar on every
  // poll is the bulk of the render cost — 48 bars x a tooltip each.
  const bars = useMemo(() => {
    const maxViews = Math.max(1, ...points.map((d) => d.views));
    const maxRevenue = Math.max(0.01, ...points.map((d) => d.revenueUsd));
    return points.map((d) => ({
      bucket: d.bucket,
      title: `${bucketLabel(d.bucket, hourly)}\n${d.views} views / ${d.visitors} visitors\n${d.payments} payments / ${usd(d.revenueUsd)}`,
      viewHeight: (d.views / maxViews) * 80,
      revenueHeight: d.revenueUsd > 0 ? Math.max(4, (d.revenueUsd / maxRevenue) * 40) : 0,
    }));
  }, [points, hourly]);

  const first = bars[0]?.bucket ?? "";
  const last = bars[bars.length - 1]?.bucket ?? "";

  return (
    <div className="rounded-xl border border-neutral-800 bg-neutral-900/40 p-4">
      <div className="flex h-32 items-end gap-1">
        {bars.map((b) => (
          <div key={b.bucket} className="group relative flex-1" title={b.title}>
            <div className="flex h-32 flex-col justify-end gap-[2px]">
              {b.revenueHeight > 0 ? (
                <div
                  className="w-full rounded-sm bg-emerald-500"
                  style={{ height: `${b.revenueHeight}px` }}
                />
              ) : null}
              <div
                className="w-full rounded-sm bg-neutral-700 group-hover:bg-neutral-500"
                style={{ height: `${b.viewHeight}px` }}
              />
            </div>
          </div>
        ))}
      </div>
      <div className="mt-2 flex items-center justify-between text-[11px] text-neutral-500">
        <span>{bucketLabel(first, hourly)}</span>
        <span className="flex items-center gap-3">
          <span className="flex items-center gap-1">
            <i className="inline-block h-2 w-2 rounded-sm bg-neutral-700" /> views
          </span>
          <span className="flex items-center gap-1">
            <i className="inline-block h-2 w-2 rounded-sm bg-emerald-500" /> revenue
          </span>
        </span>
        <span>{bucketLabel(last, hourly)}</span>
      </div>
    </div>
  );
});

/** Shows the token symbol and copies its full contract address on click. */
const TokenCell = memo(function TokenCell({ payment }: { payment: PaymentRow }) {
  const [copied, setCopied] = useState(false);
  const address = payment.consumedTokenAddress;

  useEffect(() => {
    if (!copied) return;
    const id = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(id);
  }, [copied]);

  const copy = useCallback(async () => {
    if (!address) return;
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
    } catch {
      // Clipboard blocked (insecure context) — the title attribute still shows the CA.
    }
  }, [address]);

  if (!payment.consumedAt || !address) {
    return <span className="text-neutral-600">unused</span>;
  }

  // Falls back to a truncated address for tokens scanned before we cached a symbol.
  const label = payment.consumedTokenSymbol ?? shortenAddress(address, 4);

  return (
    <button
      onClick={copy}
      title={address}
      className="group inline-flex items-center gap-1.5 text-neutral-200 hover:text-white"
    >
      <span className="font-medium">{label}</span>
      <span
        className={`text-[10px] ${copied ? "text-emerald-400" : "text-neutral-600 group-hover:text-neutral-400"}`}
      >
        {copied ? "copied" : "\u29C9"}
      </span>
    </button>
  );
});

const PaymentsTable = memo(function PaymentsTable({
  payments,
  now,
}: {
  payments: PaymentRow[];
  now: number;
}) {
  if (payments.length === 0) {
    return <p className="text-xs text-neutral-500">No payments yet.</p>;
  }
  return (
    <div className="overflow-x-auto rounded-xl border border-neutral-800">
      <table className="w-full text-left text-xs">
        <thead className="bg-neutral-900 text-neutral-500">
          <tr>
            <th className="px-3 py-2 font-medium">When</th>
            <th className="px-3 py-2 font-medium">Amount</th>
            <th className="px-3 py-2 font-medium">Tier</th>
            <th className="px-3 py-2 font-medium">Method</th>
            <th className="px-3 py-2 font-medium">Payer</th>
            <th className="px-3 py-2 font-medium">Used on</th>
            <th className="px-3 py-2 font-medium">Tx</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-neutral-800/70">
          {payments.map((p) => (
            <tr key={p.paymentId} className="text-neutral-300">
              <td className="whitespace-nowrap px-3 py-2" title={localTime(p.createdAt)}>
                {timeAgo(p.createdAt, now)}
              </td>
              <td className="px-3 py-2 font-medium text-emerald-400">{usd(p.amountUsd)}</td>
              <td className="px-3 py-2">Top {p.tier}</td>
              <td className="px-3 py-2 uppercase text-neutral-400">{p.method ?? "—"}</td>
              <td className="px-3 py-2 font-mono text-[11px] text-neutral-400">
                <span className="inline-flex items-center gap-1.5">
                  {p.payerWallet ? shortenAddress(p.payerWallet, 4) : "—"}
                  {p.isNewCustomer && (
                    <span
                      title="First purchase from this wallet"
                      className="rounded-md bg-amber-500/15 px-1.5 py-0.5 font-sans text-[9px] font-semibold uppercase tracking-wide text-amber-400"
                    >
                      New
                    </span>
                  )}
                </span>
              </td>
              <td className="px-3 py-2">
                <TokenCell payment={p} />
              </td>
              <td className="px-3 py-2">
                <a
                  href={`https://solscan.io/tx/${p.paymentId}`}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="font-mono text-[11px] text-sky-400 hover:underline"
                >
                  {shortenAddress(p.paymentId, 4)}
                </a>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
});

export default function AdminDashboard({ initial }: { initial: AdminStats }) {
  const [stats, setStats] = useState(initial);
  const [refreshing, setRefreshing] = useState(false);
  const [hourly, setHourly] = useState(false);
  // Single clock for every relative timestamp, so "3m ago" updating doesn't
  // depend on an unrelated re-render happening to occur.
  const [now, setNow] = useState(() => Date.now());

  // Guards against overlapping polls: a slow response used to let the next
  // interval tick fire another fetch, and they accumulate.
  const inFlight = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setRefreshing(true);
    try {
      const res = await fetch("/api/admin/stats", { cache: "no-store" });
      if (!res.ok) return;
      const next = await res.json();
      if (!mounted.current) return;
      setStats(next);
      setNow(Date.now());
    } catch {
      // Keep showing the last good snapshot rather than blanking the page.
    } finally {
      inFlight.current = false;
      if (mounted.current) setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    // Polling while the tab is hidden is what makes the page feel dead on
    // return: the browser throttles the timer, then fires every queued tick at
    // once. Only poll a visible tab, and refresh immediately when it comes back.
    let id: ReturnType<typeof setInterval> | null = null;

    const start = () => {
      if (id === null) id = setInterval(refresh, REFRESH_MS);
    };
    const stop = () => {
      if (id !== null) {
        clearInterval(id);
        id = null;
      }
    };

    const onVisibility = () => {
      if (document.hidden) {
        stop();
      } else {
        void refresh();
        start();
      }
    };

    if (!document.hidden) start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [refresh]);

  // Ticks the relative labels without refetching. 30s is enough for "Xm ago".
  useEffect(() => {
    const id = setInterval(() => {
      if (!document.hidden) setNow(Date.now());
    }, 30_000);
    return () => clearInterval(id);
  }, []);

  const signOut = useCallback(async () => {
    await fetch("/api/admin/login", { method: "DELETE" });
    window.location.reload();
  }, []);

  const { revenue, visitors, funnel, content } = stats;
  const conversion =
    visitors.visitors30d > 0 ? (revenue.payments / visitors.visitors30d) * 100 : 0;
  const points = hourly ? stats.hourly : stats.daily;

  return (
    <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-8 sm:px-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-neutral-100">Admin</h1>
          <p className="text-xs text-neutral-500">
            Updated {timeAgo(stats.generatedAt, now)}
            {refreshing ? " · refreshing…" : ""}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={refresh}
            className="rounded-lg border border-neutral-800 px-3 py-1.5 text-xs text-neutral-300 hover:border-neutral-600"
          >
            Refresh
          </button>
          <button
            onClick={signOut}
            className="rounded-lg border border-neutral-800 px-3 py-1.5 text-xs text-neutral-400 hover:border-neutral-600"
          >
            Sign out
          </button>
        </div>
      </header>

      <div className="mt-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Card
          label="Revenue (all time)"
          value={usd(revenue.revenueUsd)}
          sub={`${revenue.payments} payments`}
        />
        <Card
          label="Revenue 24h"
          value={usd(revenue.revenue24h)}
          sub={`${revenue.payments24h} payments · 7d ${usd(revenue.revenue7d)}`}
        />
        <Card
          label="Visitors 24h"
          value={formatCompactNumber(visitors.visitors24h)}
          sub={`${formatCompactNumber(visitors.views24h)} views · 7d ${formatCompactNumber(visitors.visitors7d)}`}
        />
        <Card
          label="Visitor → buyer"
          value={`${conversion.toFixed(2)}%`}
          sub={`${formatCompactNumber(visitors.visitors30d)} visitors in 30d`}
        />
      </div>

      <section className="mt-8">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-neutral-300">
            {hourly ? "Last 48 hours" : "Last 30 days"}
          </h2>
          <div className="flex rounded-lg border border-neutral-800 p-0.5 text-xs">
            {(
              [
                ["Hourly", true],
                ["Daily", false],
              ] as const
            ).map(([label, value]) => (
              <button
                key={label}
                onClick={() => setHourly(value)}
                className={`rounded-md px-2.5 py-1 transition ${
                  hourly === value
                    ? "bg-neutral-100 text-neutral-950"
                    : "text-neutral-400 hover:text-neutral-200"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        <TrafficBars points={points} hourly={hourly} />
      </section>

      <Section
        title={`Payments to treasury${stats.treasury ? ` · ${shortenAddress(stats.treasury, 6)}` : ""}`}
      >
        <PaymentsTable payments={stats.payments} now={now} />
      </Section>

      <Section title="API credits used today">
        <UsageTable rows={stats.usageToday} />
      </Section>

      <Section title="API credits used (last 7 days)">
        <UsageTable rows={stats.usage7d} />
      </Section>

      <div className="mt-8 grid gap-6 lg:grid-cols-2">
        <div>
          <h2 className="mb-3 text-sm font-semibold text-neutral-300">Traffic sources (30d)</h2>
          <ul className="divide-y divide-neutral-800/70 rounded-xl border border-neutral-800 text-xs">
            {stats.topReferrers.length === 0 ? (
              <li className="px-3 py-2 text-neutral-500">No visits recorded yet.</li>
            ) : (
              stats.topReferrers.map((r) => (
                <li key={r.name} className="flex justify-between px-3 py-2 text-neutral-300">
                  <span className="truncate">{r.name}</span>
                  <span className="text-neutral-500">{formatCompactNumber(r.views)}</span>
                </li>
              ))
            )}
          </ul>
        </div>
        <div>
          <h2 className="mb-3 text-sm font-semibold text-neutral-300">Countries (30d)</h2>
          <ul className="divide-y divide-neutral-800/70 rounded-xl border border-neutral-800 text-xs">
            {stats.topCountries.length === 0 ? (
              <li className="px-3 py-2 text-neutral-500">No visits recorded yet.</li>
            ) : (
              stats.topCountries.map((c) => (
                <li key={c.name} className="flex justify-between px-3 py-2 text-neutral-300">
                  <span>{c.name}</span>
                  <span className="text-neutral-500">{formatCompactNumber(c.views)}</span>
                </li>
              ))
            )}
          </ul>
        </div>
      </div>

      <Section title="Checkout funnel & database">
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Card
            label="Quotes started (30d)"
            value={formatCompactNumber(funnel.intents)}
            sub={`${funnel.intentsPaid} paid · ${funnel.intentsOpen} abandoned`}
          />
          <Card label="Tokens scanned" value={`~${formatCompactNumber(content.tokens)}`} />
          <Card
            label="Wallets stored"
            value={`~${formatCompactNumber(content.wallets)}`}
            sub={`~${formatCompactNumber(content.walletTokens)} wallet/token rows`}
          />
          <Card
            label="Cached detail lookups"
            value={`~${formatCompactNumber(content.cachedDetails)}`}
          />
        </div>
        <p className="mt-2 text-[11px] text-neutral-600">
          Row counts are planner estimates, not exact — an exact count is a full scan of every
          table.
        </p>
      </Section>
    </main>
  );
}
