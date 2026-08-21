"use client";

import { useCallback, useState } from "react";
import { formatMultiple, formatUsd } from "@/lib/format";
import { dexScreenerUrl, tradeLinksFor } from "@/lib/alerts/config";
import type { AlertFeedRow } from "@/lib/db/alerts";
import type { Chain } from "@/lib/types";
import McapSparkline from "./McapSparkline";

/**
 * One call, as a terminal line.
 *
 * Collapsed it is a single scannable row; opening it reveals who was in. That
 * split is deliberate — a feed someone keeps open all day has to be readable at
 * a glance, and the detail is only wanted for the one row in twenty that looks
 * interesting.
 *
 * The row is a `<div>`, not a `<button>`, with the expand toggle as one child
 * and the venue links as siblings. Interactive elements cannot nest: an anchor
 * inside a button is invalid HTML and browsers disagree about which one a click
 * belongs to.
 */

/** Wallets listed before the rest collapse behind a count. */
const VISIBLE_WALLETS = 6;

/** A colour per venue, so the row is scannable by shape and not just by letter. */
const BOT_CHIP: Record<string, string> = {
  Axiom: "bg-sky-500/20 text-sky-300 hover:bg-sky-500/30",
  Trojan: "bg-violet-500/20 text-violet-300 hover:bg-violet-500/30",
  GMGN: "bg-emerald-500/20 text-emerald-300 hover:bg-emerald-500/30",
  BasedBot: "bg-amber-500/20 text-amber-300 hover:bg-amber-500/30",
};

const KIND_CHIP: Record<string, string> = {
  burst: "border-emerald-500/30 bg-emerald-500/10 text-emerald-300",
  cluster: "border-amber-500/30 bg-amber-500/10 text-amber-300",
  accumulation: "border-rose-500/30 bg-rose-500/10 text-rose-300",
};

function chipFor(tier: number): string {
  if (tier >= 8) return KIND_CHIP.accumulation;
  if (tier >= 4) return KIND_CHIP.cluster;
  return KIND_CHIP.burst;
}

/** How long ago the call fired. Re-derived on render, and the parent re-renders
 * on every poll, so it stays honest without a timer of its own. */
function ago(iso: string): string {
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

function humanSpan(seconds: number): string {
  if (seconds < 60) return `${Math.max(1, Math.round(seconds))}s`;
  const m = Math.round(seconds / 60);
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h`;
}

interface Standout {
  name: string;
  bestMultipleX: number;
  bestSymbol: string;
}

/** Mirrors `bestWin` in telegram.ts so the page and the channel make the same
 * claim about the same call. The return type narrows the two nullable fields, so
 * the caller does not re-assert what was already checked. */
function standoutWin(alert: AlertFeedRow): Standout | null {
  let best: Standout | null = null;
  for (const w of alert.wallets) {
    if (w.bestMultipleX === null || !w.bestSymbol || w.bestMultipleX < 5) continue;
    if (best === null || w.bestMultipleX > best.bestMultipleX) {
      best = {
        name: w.label || w.address,
        bestMultipleX: w.bestMultipleX,
        bestSymbol: w.bestSymbol,
      };
    }
  }
  return best;
}

export default function FeedRow({ alert, fresh }: { alert: AlertFeedRow; fresh: boolean }) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(alert.tokenAddress);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Refused on an insecure origin or by permission. The address is printed
      // in full when the row is open, so there is still a way to get it.
    }
  }, [alert.tokenAddress]);

  const symbol = (alert.tokenSymbol || "?").replace(/^\$+/, "");
  const base = alert.mcapAtAlertUsd;
  const peakX = base && base > 0 && alert.athMcapUsd ? alert.athMcapUsd / base : null;
  const nowX = base && base > 0 && alert.lastMcapUsd ? alert.lastMcapUsd / base : null;
  const lowX = base && base > 0 && alert.lowMcapUsd ? alert.lowMcapUsd / base : null;
  const up = nowX === null || nowX >= 1;
  const standout = standoutWin(alert);
  const wallets = alert.wallets.slice(0, VISIBLE_WALLETS);
  const hidden = alert.wallets.length - wallets.length;
  const links = tradeLinksFor(alert.chain as Chain);

  return (
    <div
      className={`border-b border-neutral-900 transition-colors last:border-0 hover:bg-neutral-900/40 ${
        fresh ? "animate-row-land bg-blue-500/[0.04]" : ""
      }`}
    >
      <div className="flex items-center gap-2 px-3 py-2">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-label={`${alert.peakTier} wallets bought $${symbol}`}
          className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1 text-left sm:flex-nowrap"
        >
          <span
            aria-hidden
            className={`shrink-0 text-neutral-600 transition-transform ${open ? "rotate-90" : ""}`}
          >
            ›
          </span>

          <time
            dateTime={alert.createdAt}
            title={`${new Date(alert.createdAt).toISOString().slice(0, 16).replace("T", " ")} UTC`}
            className="tnum hidden w-16 shrink-0 text-[11px] text-neutral-600 sm:block"
            suppressHydrationWarning
          >
            {ago(alert.createdAt)}
          </time>

          <span
            className={`tnum w-9 shrink-0 rounded border text-center text-[11px] font-semibold ${chipFor(
              alert.peakTier
            )}`}
          >
            {alert.peakTier}w
          </span>

          <span className="w-24 shrink-0 truncate text-sm font-semibold text-neutral-50">
            ${symbol}
          </span>

          {/* The track record: the one thing nobody else can print. Fixed width
              so it never wraps under the ticker. */}
          <span className="tnum hidden w-36 shrink-0 text-xs text-neutral-400 sm:block">
            {alert.avgMultipleX !== null ? (
              <span className="font-semibold text-blue-300">
                {formatMultiple(alert.avgMultipleX)}
              </span>
            ) : (
              "—"
            )}
            {alert.avgPnlUsd !== null ? ` · ${formatUsd(alert.avgPnlUsd)}` : ""}
          </span>

          <span className="tnum hidden w-12 shrink-0 text-right text-[11px] text-neutral-500 md:block">
            {humanSpan(alert.spanSeconds)}
          </span>

          <span className="tnum w-20 shrink-0 text-right text-xs text-neutral-300">
            {base ? formatUsd(base) : "—"}
          </span>

          {/* Peak carries NO arrow: it is a running maximum seeded at the entry
              cap, so it is >= 1.00x by construction and an up-arrow beside it
              would be claiming a gain that may never have existed. Dimmed until
              it is actually meaningful. */}
          <span
            className={`tnum w-14 shrink-0 text-right text-xs ${
              peakX && peakX >= 1.2 ? "font-semibold text-blue-300" : "text-neutral-500"
            }`}
            title="Highest market cap since the call, over the cap at the call"
          >
            {peakX ? formatMultiple(peakX) : "—"}
          </span>

          {/* Now is the honest one, and the only one that gets a direction. */}
          <span
            className={`tnum w-16 shrink-0 text-right text-xs font-semibold ${
              nowX === null ? "text-neutral-500" : up ? "text-emerald-400" : "text-rose-400"
            }`}
            title="Market cap now, over the cap at the call"
          >
            {nowX ? `${up ? "▲" : "▼"} ${formatMultiple(nowX)}` : "—"}
          </span>
        </button>

        <span className="hidden shrink-0 lg:block">
          <McapSparkline samples={alert.samples} baselineUsd={base} up={up} />
        </span>

        {/* One click to a buy without opening the row. Monograms rather than the
            real logos: hotlinking four third-party favicons leaks a referrer per
            row and breaks the moment any of them moves a file. */}
        <span className="hidden shrink-0 items-center gap-1 sm:flex">
          {links.map((link) => (
            <a
              key={link.name}
              href={link.plain(alert.chain as Chain, alert.tokenAddress)}
              target="_blank"
              rel="noopener noreferrer"
              title={`Buy on ${link.name}`}
              aria-label={`Buy $${symbol} on ${link.name}`}
              className={`flex h-5 w-5 items-center justify-center rounded text-[10px] font-bold transition-colors ${
                BOT_CHIP[link.name] ?? "bg-neutral-800 text-neutral-300"
              }`}
            >
              {link.name.slice(0, 1)}
            </a>
          ))}
        </span>
      </div>

      {open ? (
        <div className="px-3 pb-3 sm:pl-[5.5rem]">
          <div className="tnum mb-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-neutral-500">
            <span>
              Called at <span className="text-neutral-300">{base ? formatUsd(base) : "—"}</span>
            </span>
            <span>
              Peak{" "}
              <span className="text-neutral-300">
                {alert.athMcapUsd ? formatUsd(alert.athMcapUsd) : "—"}
              </span>
              {peakX ? ` (${formatMultiple(peakX)})` : ""}
            </span>
            {/* The counterweight to the peak: how far underwater it went first. */}
            <span>
              Low{" "}
              <span className="text-rose-400/90">
                {alert.lowMcapUsd ? formatUsd(alert.lowMcapUsd) : "—"}
              </span>
              {lowX ? ` (${formatMultiple(lowX)})` : ""}
            </span>
            <span>
              Now{" "}
              <span className={up ? "text-emerald-400" : "text-rose-400"}>
                {alert.lastMcapUsd ? formatUsd(alert.lastMcapUsd) : "—"}
              </span>
              {nowX ? ` (${formatMultiple(nowX)})` : ""}
            </span>
          </div>

          {alert.steps.length > 1 ? (
            <p className="tnum mb-2 text-[11px] text-neutral-500">
              Called at {alert.firstTier}, escalated {alert.steps.map((s) => s.tier).join(" → ")}
            </p>
          ) : null}

          {standout ? (
            <p className="mb-2 text-xs text-neutral-400">
              ⭐ <span className="font-medium text-neutral-200">{standout.name}</span> once did{" "}
              <span className="tnum font-semibold text-blue-300">
                {formatMultiple(standout.bestMultipleX)}
              </span>{" "}
              on ${standout.bestSymbol.replace(/^\$+/, "")}
            </p>
          ) : null}

          {alert.exitedCount > 0 ? (
            <p className="mb-2 text-xs text-amber-300/90">
              ⚠️ {alert.exitedCount} of {alert.walletCount} already sold some back
            </p>
          ) : null}

          {/* ONE grid for every wallet, so the columns line up across rows.
              Per-row flex boxes could not: a short name and a long one give
              different column positions, which is what made this look ragged. */}
          <div className="grid grid-cols-[minmax(0,1fr)_auto_auto] gap-x-4 gap-y-1 text-xs">
            <div className="col-span-3 grid grid-cols-subgrid text-[10px] uppercase tracking-wider text-neutral-600">
              <span>Wallet</span>
              <span className="text-right">Avg win</span>
              <span className="text-right">Avg PNL</span>
            </div>
            {wallets.map((w) => (
              <div key={w.address} className="col-span-3 grid grid-cols-subgrid items-baseline">
                <span
                  className={`truncate ${
                    w.label ? "font-medium text-neutral-200" : "font-mono text-neutral-400"
                  }`}
                >
                  {w.label || w.address}
                  {w.exited ? (
                    <span className="ml-1.5 rounded border border-neutral-700 px-1 text-[10px] text-neutral-400">
                      sold
                    </span>
                  ) : null}
                </span>
                <span className="tnum text-right text-neutral-400">
                  {w.multipleX !== null ? formatMultiple(w.multipleX) : "—"}
                </span>
                <span className="tnum text-right text-neutral-500">
                  {w.pnlUsd !== null ? formatUsd(w.pnlUsd) : "—"}
                </span>
              </div>
            ))}
          </div>

          {hidden > 0 ? <p className="mt-1 text-[11px] text-neutral-600">+ {hidden} more</p> : null}

          <div className="mt-3 flex flex-wrap items-center gap-1.5">
            <button
              type="button"
              onClick={copy}
              className="rounded-md border border-neutral-800 bg-neutral-900 px-2 py-1 text-[11px] font-medium text-neutral-300 transition-colors hover:border-neutral-700 hover:text-neutral-50"
            >
              {copied ? "✓ Copied" : "📋 Copy CA"}
            </button>
            {links.map((link) => (
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
            <a
              href={dexScreenerUrl(alert.chain as Chain, alert.tokenAddress)}
              target="_blank"
              rel="noopener noreferrer"
              className="rounded-md border border-neutral-800 bg-neutral-900 px-2 py-1 text-[11px] font-medium text-neutral-300 transition-colors hover:border-neutral-700 hover:text-neutral-50"
            >
              Chart
            </a>
            <code className="ml-auto max-w-full truncate font-mono text-[10px] text-neutral-600">
              {alert.tokenAddress}
            </code>
          </div>
        </div>
      ) : null}
    </div>
  );
}
