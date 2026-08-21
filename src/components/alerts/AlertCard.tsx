"use client";

import { useState } from "react";
import { formatMultiple, formatUsd } from "@/lib/format";
import { dexScreenerUrl, tradeLinksFor, tierFor } from "@/lib/alerts/config";
import type { Chain } from "@/lib/types";
import type { AlertFeedRow } from "@/lib/db/alerts";
import McapSparkline from "./McapSparkline";

/**
 * One fired alert.
 *
 * The card is ordered by what a reader decides on, top to bottom: what shape of
 * alert this was, which token, how good the wallets in it are, what the token
 * has done since, and only then who exactly was in it.
 */

/** Wallets shown before the list collapses. Enough to judge the call; past this
 * a 20-wallet accumulation alert becomes a wall of addresses. */
const VISIBLE_WALLETS = 3;

const TIER_STYLES: Record<string, string> = {
  burst: "border-emerald-500/30 bg-emerald-500/10 text-emerald-300",
  cluster: "border-amber-500/30 bg-amber-500/10 text-amber-300",
  accumulation: "border-rose-500/30 bg-rose-500/10 text-rose-300",
};

function relativeTime(iso: string): string {
  const seconds = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function humanSpan(seconds: number): string {
  if (seconds < 60) return `${Math.max(1, Math.round(seconds))}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
}

export default function AlertCard({ alert }: { alert: AlertFeedRow }) {
  const [expanded, setExpanded] = useState(false);

  const tier = tierFor(alert.tier);
  const symbol = (alert.tokenSymbol || "?").replace(/^\$+/, "");
  const base = alert.mcapAtAlertUsd;
  const peakX = base && base > 0 && alert.athMcapUsd ? alert.athMcapUsd / base : null;
  const nowX = base && base > 0 && alert.lastMcapUsd ? alert.lastMcapUsd / base : null;
  // One source of truth for "is it up", shared by the figures and the sparkline.
  const up = nowX === null || nowX >= 1;

  const wallets = expanded ? alert.wallets : alert.wallets.slice(0, VISIBLE_WALLETS);
  const hidden = alert.wallets.length - wallets.length;

  return (
    <article className="animate-fade-in rounded-xl border border-neutral-800/80 bg-neutral-900/40 p-4 transition-colors hover:border-neutral-700/80">
      <header className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span
          className={`rounded-md border px-2 py-0.5 text-[11px] font-semibold ${
            TIER_STYLES[tier?.kind ?? "burst"]
          }`}
        >
          {alert.tier} in {humanSpan(alert.windowSeconds)}
        </span>

        {alert.tokenImageUrl ? (
          /* Arbitrary remote token art from a live feed. Running every memecoin
             logo through the image optimiser would bill us per alert, and these
             are 24px. */
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={alert.tokenImageUrl}
            alt=""
            className="h-6 w-6 rounded-full bg-neutral-800 object-cover"
            loading="lazy"
          />
        ) : null}

        <div className="min-w-0">
          <a
            href={dexScreenerUrl(alert.chain as Chain, alert.tokenAddress)}
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm font-semibold text-neutral-50 transition-colors hover:text-blue-300"
          >
            ${symbol}
          </a>
          {alert.tokenName && alert.tokenName !== alert.tokenSymbol ? (
            <span className="ml-2 truncate text-xs text-neutral-500">{alert.tokenName}</span>
          ) : null}
        </div>

        {/* `suppressHydrationWarning` because this is a clock: the server
            renders "2m ago" and the browser hydrates a moment later, which
            across a minute boundary is a different string and a hard hydration
            error. The title is a fixed UTC stamp rather than `toLocaleString`
            for the same reason — the server's timezone is not the reader's. */}
        <time
          dateTime={alert.createdAt}
          className="ml-auto shrink-0 text-[11px] text-neutral-500"
          title={`${alert.createdAt.slice(0, 16).replace("T", " ")} UTC`}
          suppressHydrationWarning
        >
          {relativeTime(alert.createdAt)}
        </time>
      </header>

      <p className="mt-3 text-sm text-neutral-300">
        <span className="tnum font-semibold text-neutral-50">{alert.walletCount}</span> smart
        wallets bought within{" "}
        <span className="tnum font-semibold text-neutral-50">{humanSpan(alert.spanSeconds)}</span>
        {alert.avgMultipleX !== null ? (
          <>
            {" · avg "}
            <span className="tnum font-semibold text-blue-300">
              {formatMultiple(alert.avgMultipleX)}
            </span>
          </>
        ) : null}
        {alert.avgPnlUsd !== null ? (
          <>
            {" · avg "}
            <span className="tnum font-semibold text-blue-300">{formatUsd(alert.avgPnlUsd)}</span>
            {" PNL"}
          </>
        ) : null}
      </p>

      {/* Performance. `peak` is why the whole hourly tracker exists, so it gets
          the emphasis; `now` is the honest counterweight beside it. */}
      <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-2 rounded-lg border border-neutral-800/60 bg-neutral-950/50 px-3 py-2.5">
        <Figure label="At alert" value={base ? formatUsd(base) : "—"} />
        <Figure
          label="Peak"
          value={alert.athMcapUsd ? formatUsd(alert.athMcapUsd) : "—"}
          delta={peakX}
          emphasis
        />
        <Figure
          label="Now"
          value={alert.lastMcapUsd ? formatUsd(alert.lastMcapUsd) : "—"}
          delta={nowX}
        />
        <div className="ml-auto">
          <McapSparkline samples={alert.samples} baselineUsd={base} up={up} />
        </div>
      </div>

      <ul className="mt-3 space-y-1.5">
        {wallets.map((wallet) => (
          <li key={wallet.address} className="flex flex-wrap items-baseline gap-x-2 text-xs">
            {/* Not a link. The feed masks addresses on purpose — the curated
                wallet list is the paid product — so there is nothing here a
                block explorer could resolve. */}
            <span
              className={
                wallet.label ? "font-medium text-neutral-200" : "font-mono text-neutral-400"
              }
            >
              {wallet.label || wallet.address}
            </span>
            {wallet.multipleX !== null ? (
              <span className="tnum text-neutral-400">{formatMultiple(wallet.multipleX)} avg</span>
            ) : null}
            {wallet.pnlUsd !== null ? (
              <span className="tnum text-neutral-500">{formatUsd(wallet.pnlUsd)}</span>
            ) : null}
            <span className="tnum ml-auto text-neutral-300">{formatUsd(wallet.boughtUsd)} in</span>
            {wallet.exited ? (
              // Still counted toward the tier — the entry is the signal — but
              // anyone chasing this call deserves to know before they buy.
              <span className="rounded border border-neutral-700 px-1 text-[10px] text-neutral-400">
                sold
              </span>
            ) : null}
          </li>
        ))}
      </ul>

      {hidden > 0 ? (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="mt-2 text-[11px] font-medium text-neutral-400 transition-colors hover:text-neutral-200"
        >
          Show {hidden} more {hidden === 1 ? "wallet" : "wallets"}
        </button>
      ) : null}

      <footer className="mt-3 flex flex-wrap items-center gap-1.5 border-t border-neutral-800/60 pt-3">
        {tradeLinksFor(alert.chain as Chain).map((link) => (
          <a
            key={link.name}
            href={link.plain(alert.chain as Chain, alert.tokenAddress)}
            target="_blank"
            rel="noopener noreferrer"
            className="rounded-md border border-neutral-800 bg-neutral-900 px-2 py-1 text-[11px] font-medium text-neutral-300 transition-colors hover:border-neutral-700 hover:text-neutral-50"
          >
            {link.name}
          </a>
        ))}
        <code className="ml-auto max-w-full truncate font-mono text-[10px] text-neutral-600">
          {alert.tokenAddress}
        </code>
      </footer>
    </article>
  );
}

/** One market-cap figure with its multiple against the alert cap. The arrow and
 * the label carry the direction alongside the colour — a status colour never
 * carries meaning on its own. */
function Figure({
  label,
  value,
  delta,
  emphasis = false,
}: {
  label: string;
  value: string;
  delta?: number | null;
  emphasis?: boolean;
}) {
  const up = delta !== null && delta !== undefined && delta >= 1;
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-neutral-500">{label}</div>
      <div className="flex items-baseline gap-1.5">
        <span
          className={`tnum text-sm font-semibold ${
            emphasis ? "text-neutral-50" : "text-neutral-300"
          }`}
        >
          {value}
        </span>
        {delta !== null && delta !== undefined ? (
          <span
            className={`tnum text-[11px] font-medium ${up ? "text-emerald-400" : "text-rose-400"}`}
          >
            {up ? "▲" : "▼"} {formatMultiple(delta)}
          </span>
        ) : null}
      </div>
    </div>
  );
}
