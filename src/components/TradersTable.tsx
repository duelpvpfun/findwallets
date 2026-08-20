"use client";

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { Chain, TokenMeta, WalletHistory, WalletTrader } from "@/lib/types";
import {
  NATIVE_UNIT,
  formatCompactNumber,
  formatMultiple,
  formatPercent,
  formatSol,
  formatUsd,
  formatWinBadge,
  shortenAddress,
} from "@/lib/format";
import { buildExportJson, copyText } from "@/lib/export";
import { useMediaQuery } from "@/lib/useMediaQuery";
import ExportDialog from "./ExportDialog";
import ShareCardModal from "./ShareCardModal";

/** Below this a plain list is cheaper than the virtualizer's bookkeeping. */
const VIRTUALIZE_THRESHOLD = 100;

/** Shortcuts must never fire while the user is filling in a field. */
function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    target.tagName === "INPUT" ||
    target.tagName === "TEXTAREA" ||
    target.tagName === "SELECT"
  );
}

interface TradersTableProps {
  token: TokenMeta;
  traders: WalletTrader[];
  isDemoData: boolean;
  histories?: Record<string, WalletHistory>;
  /** Unused while wallet-detail lookups are disabled (too costly per-click);
   * kept so callers don't need to change and it's a one-line revert to re-wire. */
  scanSession?: string;
  /** The scan hit its time budget before filling the tier the buyer paid for. */
  partial?: boolean;
  requestedCount?: number;
  /** Returns to the search screen. Omit to hide the back control. */
  onBack?: () => void;
}

/** Realized counts only closed volume; total adds the paper value of tokens the
 * wallet still holds, which upstream reports as unrealized PNL. */
type PnlBasis = "realized" | "total";

/** A trader with the PNL figures the current basis should display. */
interface Row extends WalletTrader {
  pnlUsd: number;
  pnlPercent: number;
  /** Null when the basis was too small to measure a return against. */
  multipleX: number | null;
  unsoldPnlUsd: number;
}

const NO_MULTIPLE_REASON =
  "No measurable return: almost all of these tokens arrived by transfer rather than being bought, so there is no cost basis to divide the profit by. The PNL is still real.";

// Avg X is PNL over capital deployed, so it deliberately does not equal
// Avg Exit / Avg Entry whenever a wallet didn't sell everything it bought.
function avgXBasis(basis: PnlBasis) {
  const profit = basis === "total" ? "Total profit (sold + still held)" : "Realized profit";
  const basisLabel =
    basis === "total"
      ? "the USD cost of the tokens sold plus those still held"
      : "the USD cost of the tokens actually sold";
  return `${profit} \u00f7 ${basisLabel} (e.g. 1.40x = +40%). This is not Avg Exit \u00f7 Avg Entry: Avg Entry averages every token bought, including any the wallet never sold.`;
}

/** Columns the user can sort by. Each cycles desc -> asc -> off. */
type SortKey = "multipleX" | "pnlPercent" | "pnlUsd";
type SortDir = "desc" | "asc";
interface Sort {
  key: SortKey;
  dir: SortDir;
}

interface Filters {
  query: string;
  minX: string;
  maxX: string;
  minPnlPercent: string;
  maxPnlPercent: string;
  minPnlUsd: string;
  maxPnlUsd: string;
  holdingOnly: boolean;
  provenOnly: boolean;
}

const EMPTY_FILTERS: Filters = {
  query: "",
  minX: "",
  maxX: "",
  minPnlPercent: "",
  maxPnlPercent: "",
  minPnlUsd: "",
  maxPnlUsd: "",
  holdingOnly: false,
  provenOnly: false,
};

export default function TradersTable({
  token,
  traders,
  isDemoData,
  histories = {},
  partial = false,
  requestedCount,
  onBack,
}: TradersTableProps) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [shareTarget, setShareTarget] = useState<WalletTrader | null>(null);
  const isDesktop = useMediaQuery("(min-width: 1024px)");
  const [showMcap, setShowMcap] = useState(true);
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [sort, setSort] = useState<Sort | null>(null);
  const [pnlBasis, setPnlBasis] = useState<PnlBasis>("total");

  // Chains without an unrealized figure can only ever show realized, so the
  // toggle is hidden there rather than offering two identical views.
  const hasUnrealizedData = useMemo(
    () => traders.some((t) => t.unrealizedPnlUsd !== null && t.unrealizedPnlUsd !== 0),
    [traders]
  );
  const basis: PnlBasis = hasUnrealizedData ? pnlBasis : "realized";

  const rows = useMemo<Row[]>(
    () =>
      traders.map((t) => {
        const unsoldPnlUsd = t.unrealizedPnlUsd ?? 0;
        if (basis === "realized" || unsoldPnlUsd === 0 || t.boughtUsd <= 0) {
          return {
            ...t,
            pnlUsd: t.realizedPnlUsd,
            pnlPercent: t.realizedPnlPercent,
            multipleX: t.avgMultipleX,
            unsoldPnlUsd,
          };
        }
        // Total covers sold lots plus the bag still held, so the denominator is
        // the cost of both — not every dollar ever spent, which would include
        // tokens transferred away.
        const pnlUsd = t.realizedPnlUsd + unsoldPnlUsd;
        const heldCostUsd = Math.max(0, (t.remainingValueUsd ?? 0) - unsoldPnlUsd);
        const totalBasis = t.soldCostBasisUsd + heldCostUsd || t.boughtUsd;
        return {
          ...t,
          pnlUsd,
          pnlPercent: (pnlUsd / totalBasis) * 100,
          multipleX: 1 + pnlUsd / totalBasis,
          unsoldPnlUsd,
        };
      }),
    [traders, basis]
  );

  const matchingTraders = useMemo(() => {
    const minX = parseFloat(filters.minX);
    const maxX = parseFloat(filters.maxX);
    const minPnlPercent = parseFloat(filters.minPnlPercent);
    const maxPnlPercent = parseFloat(filters.maxPnlPercent);
    const minPnlUsd = parseFloat(filters.minPnlUsd);
    const maxPnlUsd = parseFloat(filters.maxPnlUsd);
    const query = filters.query.trim().toLowerCase();
    return rows.filter((t) => {
      if (
        query &&
        !t.address.toLowerCase().includes(query) &&
        !(t.nickname ?? "").toLowerCase().includes(query)
      ) {
        return false;
      }
      if (!Number.isNaN(minX) && (t.multipleX === null || t.multipleX < minX)) return false;
      if (!Number.isNaN(maxX) && (t.multipleX === null || t.multipleX > maxX)) return false;
      if (!Number.isNaN(minPnlPercent) && t.pnlPercent < minPnlPercent) return false;
      if (!Number.isNaN(maxPnlPercent) && t.pnlPercent > maxPnlPercent) return false;
      if (!Number.isNaN(minPnlUsd) && t.pnlUsd < minPnlUsd) return false;
      if (!Number.isNaN(maxPnlUsd) && t.pnlUsd > maxPnlUsd) return false;
      if (filters.holdingOnly && t.isHolding !== true) return false;
      if (filters.provenOnly && !hasTrackRecord(histories[t.address])) return false;
      return true;
    });
  }, [rows, filters, histories]);

  // Sorting sits on top of filtering so the two compose. With no sort active the
  // list keeps the upstream ranking order, except under Total — upstream ranks on
  // realized alone, which would leave the biggest number partway down the table.
  const filteredTraders = useMemo(() => {
    if (!sort) {
      if (basis !== "total") return matchingTraders;
      return [...matchingTraders].sort((a, b) => b.pnlUsd - a.pnlUsd);
    }
    const factor = sort.dir === "desc" ? -1 : 1;
    // Rows with no measurable multiple sort last in either direction rather than
    // being treated as 0x.
    return [...matchingTraders].sort((a, b) => {
      const av = a[sort.key];
      const bv = b[sort.key];
      if (av === null) return 1;
      if (bv === null) return -1;
      return (av - bv) * factor;
    });
  }, [matchingTraders, sort, basis]);

  const toggleSort = useCallback((key: SortKey) => {
    setSort((prev) => {
      if (prev?.key !== key) return { key, dir: "desc" };
      if (prev.dir === "desc") return { key, dir: "asc" };
      return null;
    });
  }, []);

  // Only Solana reports live balances; elsewhere the column would be all dashes.
  const hasHoldingData = traders.some((t) => t.isHolding !== null);

  // Wallets our own database has already caught winning on a different token.
  const provenCount = useMemo(
    () => traders.filter((t) => hasTrackRecord(histories[t.address])).length,
    [traders, histories]
  );

  // Compared against the visible rows, so filtering out a selected wallet can't
  // leave the header checkbox claiming everything is selected.
  const allSelected =
    filteredTraders.length > 0 && filteredTraders.every((t) => selected.has(t.address));

  // Summed over the filtered rows: a stats strip that describes wallets the
  // filter is hiding contradicts the table underneath it.
  const summary = useMemo(() => {
    const totalPnl = filteredTraders.reduce((sum, t) => sum + t.pnlUsd, 0);
    const winners = filteredTraders.filter((t) => t.pnlUsd > 0).length;
    // Rows with no measurable multiple are left out of the average rather than
    // counted as 0x, which would drag the headline figure down.
    const measurable = filteredTraders.filter((t) => t.multipleX !== null);
    const avgX =
      measurable.length > 0
        ? measurable.reduce((sum, t) => sum + (t.multipleX ?? 0), 0) / measurable.length
        : 0;
    return { totalPnl, winners, avgX };
  }, [filteredTraders]);

  const toggleAll = useCallback(() => {
    setSelected((prev) => {
      const everySelected =
        filteredTraders.length > 0 && filteredTraders.every((t) => prev.has(t.address));
      return everySelected ? new Set<string>() : new Set(filteredTraders.map((t) => t.address));
    });
  }, [filteredTraders]);

  // Stable across renders and takes the address as an argument, so the memoized
  // rows below aren't invalidated by a fresh closure on every parent render.
  const toggleOne = useCallback((address: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(address)) next.delete(address);
      else next.add(address);
      return next;
    });
  }, []);

  const handleShare = useCallback((trader: WalletTrader) => setShareTarget(trader), []);

  const searchRef = useRef<HTMLInputElement>(null);
  const copyRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.metaKey || e.ctrlKey || e.altKey || isTypingTarget(e.target)) return;
      if (e.key === "/") {
        e.preventDefault();
        searchRef.current?.focus();
      } else if (e.key === "a") {
        e.preventDefault();
        toggleAll();
      } else if (e.key === "c") {
        e.preventDefault();
        copyRef.current?.click();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggleAll]);

  // Export only what the user can see; exporting filtered-out rows is a surprise.
  const selectedTraders = useMemo(
    () => filteredTraders.filter((t) => selected.has(t.address)),
    [filteredTraders, selected]
  );

  const [exportTargets, setExportTargets] = useState<WalletTrader[] | null>(null);

  // Selecting rows narrows both buttons; otherwise they act on everything shown.
  const copyTargets = selectedTraders.length > 0 ? selectedTraders : filteredTraders;

  function updateFilter<K extends keyof Filters>(key: K, value: Filters[K]) {
    setFilters((prev) => ({ ...prev, [key]: value }));
  }

  const activeFilterCount =
    (filters.query !== "" ? 1 : 0) +
    (filters.minX !== "" ? 1 : 0) +
    (filters.maxX !== "" ? 1 : 0) +
    (filters.minPnlPercent !== "" ? 1 : 0) +
    (filters.maxPnlPercent !== "" ? 1 : 0) +
    (filters.minPnlUsd !== "" ? 1 : 0) +
    (filters.maxPnlUsd !== "" ? 1 : 0) +
    (filters.holdingOnly ? 1 : 0) +
    (filters.provenOnly ? 1 : 0);

  return (
    <div className="overflow-hidden rounded-2xl border border-neutral-800/80 bg-neutral-900/40 shadow-xl shadow-black/10">
      {/* Token header */}
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-neutral-800/80 bg-gradient-to-b from-neutral-900/60 to-transparent px-4 py-4 sm:px-5">
        <div className="flex min-w-0 items-center gap-3">
          {onBack && (
            <button
              onClick={onBack}
              aria-label="Back to search"
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-neutral-800 bg-neutral-900 text-neutral-400 transition-colors hover:border-neutral-700 hover:bg-neutral-800 hover:text-neutral-100"
            >
              <BackIcon />
            </button>
          )}
          {token.imageUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={token.imageUrl}
              alt=""
              className="h-10 w-10 shrink-0 rounded-full border border-neutral-800 object-cover sm:h-11 sm:w-11"
            />
          ) : (
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-neutral-800 text-sm font-bold text-neutral-400 sm:h-11 sm:w-11">
              {token.symbol.slice(0, 2)}
            </div>
          )}
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="truncate text-base font-semibold text-neutral-50">{token.name}</h2>
              <span className="rounded-md bg-neutral-800 px-1.5 py-0.5 text-[11px] font-medium text-neutral-400">
                {token.symbol}
              </span>
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-1.5">
              <Badge tone={token.source === "pumpfun" ? "emerald" : token.source === "raydium" ? "purple" : "neutral"}>
                {token.source === "pumpfun" ? "Pump.fun" : token.source === "raydium" ? "Raydium" : token.market ?? "Unknown"}
              </Badge>
              {token.isToken2022 && <Badge tone="amber">Token-2022</Badge>}
              {token.rankingWindow !== "all_time" && (
                <Badge tone="neutral">Ranked over last {token.rankingWindow}, not all-time</Badge>
              )}
              {isDemoData && <Badge tone="yellow">Demo data — API key not configured for this chain</Badge>}
            </div>
          </div>
        </div>

        <div className="flex w-full items-center gap-2 sm:w-auto">
          <span className="hidden text-xs text-neutral-500 sm:inline">
            {selected.size > 0 ? `${selected.size} selected` : `${traders.length} wallets`}
          </span>
          <CopyJsonButton
            ref={copyRef}
            tokenSymbol={token.symbol}
            targets={copyTargets}
            selectedCount={selected.size}
          />
          <button
            onClick={() => setExportTargets(copyTargets)}
            className="flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-gradient-to-b from-blue-500 to-blue-600 px-3 py-2 text-xs font-semibold text-white shadow shadow-blue-600/20 transition-all hover:from-blue-400 hover:to-blue-500 sm:flex-none"
          >
            <DownloadIcon />
            Export{selected.size > 0 ? ` (${selected.size})` : " All"}
          </button>
        </div>
      </div>

      {partial && (
        <div className="flex flex-wrap items-center gap-3 border-b border-amber-900/50 bg-amber-950/20 px-4 py-3 sm:px-5">
          <span className="rounded-md bg-amber-500/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-400">
            Partial
          </span>
          <span className="text-sm text-neutral-300">
            The data provider was slow, so this scan stopped at {traders.length}
            {requestedCount ? ` of ${requestedCount}` : ""} wallets. These rows are yours to keep and
            export. A fresh scan needs a new purchase — if you think this one under-delivered,{" "}
            <a href="/recover" className="font-medium text-amber-400 underline hover:text-amber-300">
              recover your purchase
            </a>{" "}
            or contact support with your transaction id.
          </span>
        </div>
      )}

      {/* Quick stats strip */}
      <div className="grid grid-cols-3 divide-x divide-neutral-800/80 border-b border-neutral-800/80 bg-neutral-950/40">
        <StatCell
          label={basis === "total" ? "Combined Total PNL" : "Combined Realized PNL"}
          value={formatUsd(summary.totalPnl)}
          positive={summary.totalPnl >= 0}
        />
        <StatCell label="Winning Wallets" value={`${summary.winners} / ${traders.length}`} />
        <StatCell label="Avg Multiple" value={formatMultiple(summary.avgX)} />
      </div>

      {/* Filter bar */}
      <div className="border-b border-neutral-800/80 px-4 py-3 sm:px-5">
        <div className="flex flex-wrap items-center gap-2">
          <input
            ref={searchRef}
            value={filters.query}
            onChange={(e) => updateFilter("query", e.target.value)}
            placeholder="Filter wallets…  /"
            spellCheck={false}
            aria-label="Filter wallets by address or name"
            className="w-full min-w-0 rounded-lg border border-neutral-800 bg-neutral-950 px-3 py-1.5 font-mono text-xs text-neutral-100 outline-none transition-colors placeholder:font-sans placeholder:text-neutral-600 focus:border-blue-500/60 focus:ring-2 focus:ring-blue-500/20 sm:w-56"
          />
          <button
            onClick={() => setFiltersOpen((v) => !v)}
            className="flex items-center gap-1.5 rounded-lg border border-neutral-800 bg-neutral-900 px-3 py-1.5 text-xs font-medium text-neutral-300 hover:border-neutral-700"
          >
            <FilterIcon />
            Filters
            {activeFilterCount > 0 && (
              <span className="flex h-4 w-4 items-center justify-center rounded-full bg-blue-500 text-[10px] font-bold text-white">
                {activeFilterCount}
              </span>
            )}
          </button>
          <span className="text-xs text-neutral-600">
            {filteredTraders.length} / {traders.length} shown
          </span>

          {hasUnrealizedData && (
            <div className="flex items-center gap-1.5">
              <span className="hidden text-xs text-neutral-500 sm:inline">PNL</span>
              <div className="flex overflow-hidden rounded-lg border border-neutral-800 text-xs font-medium">
                <button
                  onClick={() => setPnlBasis("total")}
                  title="Realized profit plus the paper value of tokens still held"
                  className={`px-2.5 py-1.5 transition-colors ${
                    pnlBasis === "total"
                      ? "bg-blue-500/20 text-blue-300"
                      : "bg-neutral-900 text-neutral-500 hover:text-neutral-300"
                  }`}
                >
                  Total
                </button>
                <button
                  onClick={() => setPnlBasis("realized")}
                  title="Profit from tokens actually sold"
                  className={`px-2.5 py-1.5 transition-colors ${
                    pnlBasis === "realized"
                      ? "bg-blue-500/20 text-blue-300"
                      : "bg-neutral-900 text-neutral-500 hover:text-neutral-300"
                  }`}
                >
                  Realized
                </button>
              </div>
              <span className="text-[10px] text-rose-400/90">
                *Traders are ranked by realized PNL
              </span>
            </div>
          )}

          <div className="ml-auto flex items-center gap-1.5">
            <span className="hidden text-xs text-neutral-500 sm:inline">Entry/Exit as</span>
            <div className="flex overflow-hidden rounded-lg border border-neutral-800 text-xs font-medium">
              <button
                onClick={() => setShowMcap(true)}
                className={`px-2.5 py-1.5 transition-colors ${
                  showMcap ? "bg-blue-500/20 text-blue-300" : "bg-neutral-900 text-neutral-500 hover:text-neutral-300"
                }`}
              >
                Mcap
              </button>
              <button
                onClick={() => setShowMcap(false)}
                className={`px-2.5 py-1.5 transition-colors ${
                  !showMcap ? "bg-blue-500/20 text-blue-300" : "bg-neutral-900 text-neutral-500 hover:text-neutral-300"
                }`}
              >
                Price
              </button>
            </div>
          </div>
        </div>

        {filtersOpen && (
          <div className="mt-3 flex flex-wrap items-end gap-x-4 gap-y-3 rounded-xl border border-neutral-800/80 bg-neutral-950/40 p-3 animate-fade-in">
            <FilterRangeInput
              label="Avg X"
              minValue={filters.minX}
              maxValue={filters.maxX}
              onMinChange={(v) => updateFilter("minX", v)}
              onMaxChange={(v) => updateFilter("maxX", v)}
              minPlaceholder="0"
              maxPlaceholder="∞"
            />
            <FilterRangeInput
              label="% PNL"
              minValue={filters.minPnlPercent}
              maxValue={filters.maxPnlPercent}
              onMinChange={(v) => updateFilter("minPnlPercent", v)}
              onMaxChange={(v) => updateFilter("maxPnlPercent", v)}
              minPlaceholder="0"
              maxPlaceholder="∞"
            />
            <FilterRangeInput
              label="$ PNL"
              minValue={filters.minPnlUsd}
              maxValue={filters.maxPnlUsd}
              onMinChange={(v) => updateFilter("minPnlUsd", v)}
              onMaxChange={(v) => updateFilter("maxPnlUsd", v)}
              minPlaceholder="0"
              maxPlaceholder="∞"
            />
            {hasHoldingData && (
              <label className="flex items-center gap-1.5 pb-1.5 text-xs text-neutral-400">
                <input
                  type="checkbox"
                  checked={filters.holdingOnly}
                  onChange={(e) => updateFilter("holdingOnly", e.target.checked)}
                  className="h-3.5 w-3.5 accent-blue-500"
                />
                Holding only
              </label>
            )}
            {provenCount > 0 && (
              <label className="flex items-center gap-1.5 pb-1.5 text-xs text-neutral-400">
                <input
                  type="checkbox"
                  checked={filters.provenOnly}
                  onChange={(e) => updateFilter("provenOnly", e.target.checked)}
                  className="h-3.5 w-3.5 accent-amber-500"
                />
                Repeat winners only
                <span className="text-neutral-600">({provenCount})</span>
              </label>
            )}
            {activeFilterCount > 0 && (
              <button
                onClick={() => setFilters(EMPTY_FILTERS)}
                className="pb-1.5 text-xs text-neutral-500 underline hover:text-neutral-300"
              >
                Clear all
              </button>
            )}
          </div>
        )}
      </div>

      <details className="group border-b border-neutral-800/80 bg-neutral-950/30">
        <summary className="flex cursor-pointer list-none items-center gap-1.5 px-4 py-2 text-[11px] text-neutral-500 hover:text-neutral-300 sm:px-5">
          <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full bg-neutral-800 text-[9px] font-bold text-neutral-400">
            ?
          </span>
          Why Avg X isn&apos;t Exit ÷ Entry
        </summary>
        <p className="px-4 pb-2.5 text-[11px] leading-relaxed text-neutral-500 sm:px-5">
          Avg X is {basis === "total" ? "total" : "realized"} profit ÷ the cost of the tokens it
          applies to — the ones actually sold{basis === "total" ? ", plus those still held" : ""}.
          Avg Entry averages every token bought, so it can include tokens the wallet never sold —
          which is why Exit ÷ Entry doesn&apos;t match.
          {hasUnrealizedData && (
            <>
              {" "}
              Wallets often receive or send tokens outside of trades, so bought and sold amounts
              don&apos;t have to match. <strong className="font-medium text-neutral-400">Total</strong>{" "}
              PNL adds the current paper value of whatever is still held;{" "}
              <strong className="font-medium text-neutral-400">Realized</strong> counts only closed
              trades.
            </>
          )}
        </p>
      </details>

      {filteredTraders.length === 0 && (
        <div className="py-12 text-center text-sm text-neutral-500">
          No traders match the current filters.
        </div>
      )}

      {/* Exactly one list is mounted. Rendering both and hiding one with CSS
          meant ~1000 live row subtrees at Top 500, so any state change in this
          component re-rendered all of them. */}
      {filteredTraders.length > 0 &&
        (isDesktop ? (
          <DesktopTable
            rows={filteredTraders}
            token={token}
            histories={histories}
            selected={selected}
            allSelected={allSelected}
            onToggleAll={toggleAll}
            onToggle={toggleOne}
            onShare={handleShare}
            showMcap={showMcap}
            basis={basis}
            hasHoldingData={hasHoldingData}
            sort={sort}
            onSort={toggleSort}
          />
        ) : (
          <CardList
            rows={filteredTraders}
            token={token}
            histories={histories}
            selected={selected}
            onToggle={toggleOne}
            onShare={handleShare}
            showMcap={showMcap}
            basis={basis}
            hasHoldingData={hasHoldingData}
          />
        ))}

      {exportTargets && (
        <ExportDialog
          tokenName={token.name}
          tokenSymbol={token.symbol}
          traders={exportTargets}
          onClose={() => setExportTargets(null)}
        />
      )}

      {shareTarget && (
        <ShareCardModal token={token} trader={shareTarget} onClose={() => setShareTarget(null)} />
      )}
    </div>
  );
}

/**
 * Owns its own `copyState` so the 2s "Copied!" flash can't re-render 500 rows,
 * and yields a frame before the synchronous JSON build so the pending state
 * actually paints first.
 */
function CopyJsonButton({
  ref,
  tokenSymbol,
  targets,
  selectedCount,
}: {
  ref?: React.Ref<HTMLButtonElement>;
  tokenSymbol: string;
  targets: WalletTrader[];
  selectedCount: number;
}) {
  const [state, setState] = useState<"idle" | "working" | "copied" | "failed">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  async function handleCopy() {
    setState("working");
    await new Promise((resolve) => requestAnimationFrame(resolve));
    const ok = await copyText(buildExportJson(tokenSymbol, targets));
    setState(ok ? "copied" : "failed");
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setState("idle"), 2000);
  }

  return (
    <button
      ref={ref}
      onClick={handleCopy}
      disabled={state === "working"}
      title="Copy the export JSON to your clipboard (c) — no download needed"
      className={`flex flex-1 items-center justify-center gap-1.5 rounded-lg border px-3 py-2 text-xs font-medium transition-colors sm:flex-none ${
        state === "copied"
          ? "border-emerald-700/60 bg-emerald-950/40 text-emerald-300"
          : state === "failed"
          ? "border-rose-800/60 bg-rose-950/40 text-rose-300"
          : "border-neutral-800 bg-neutral-900 text-neutral-200 hover:border-neutral-700 hover:bg-neutral-800"
      }`}
    >
      {state === "copied" ? <CheckIcon /> : <CopyIcon />}
      {state === "copied"
        ? "Copied!"
        : state === "failed"
        ? "Copy failed"
        : state === "working"
        ? "Copying…"
        : `Copy JSON${selectedCount > 0 ? ` (${selectedCount})` : ""}`}
    </button>
  );
}

interface ListProps {
  rows: Row[];
  token: TokenMeta;
  histories: Record<string, WalletHistory>;
  selected: Set<string>;
  onToggle: (address: string) => void;
  onShare: (trader: WalletTrader) => void;
  showMcap: boolean;
  basis: PnlBasis;
  hasHoldingData: boolean;
}

const ROW_ESTIMATE_PX = 84;
const CARD_ESTIMATE_PX = 150;

function DesktopTable({
  rows,
  token,
  histories,
  selected,
  allSelected,
  onToggleAll,
  onToggle,
  onShare,
  showMcap,
  basis,
  hasHoldingData,
  sort,
  onSort,
}: ListProps & {
  allSelected: boolean;
  onToggleAll: () => void;
  sort: Sort | null;
  onSort: (key: SortKey) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualize = rows.length > VIRTUALIZE_THRESHOLD;
  const virtualizer = useVirtualizer({
    count: virtualize ? rows.length : 0,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_ESTIMATE_PX,
    overscan: 12,
  });
  const items = virtualizer.getVirtualItems();

  return (
    <div
      ref={scrollRef}
      className={virtualize ? "max-h-[75vh] overflow-y-auto" : undefined}
    >
      <table className="w-full table-fixed text-left text-sm">
        <thead className={virtualize ? "sticky top-0 z-10 bg-neutral-900" : undefined}>
          <tr className="border-b border-neutral-800/80 text-[11px] uppercase tracking-wide text-neutral-500">
            <th className="w-9 py-2.5 pl-4 xl:pl-5">
              <input
                type="checkbox"
                checked={allSelected}
                onChange={onToggleAll}
                className="h-3.5 w-3.5 accent-blue-500"
              />
            </th>
            <th className="w-11 py-2.5 font-medium">#</th>
            <th className="w-[26%] py-2.5 font-medium">Wallet</th>
            <SortableHeader
              label="Avg X"
              sortKey="multipleX"
              sort={sort}
              onToggle={onSort}
              title={avgXBasis(basis)}
              className="w-[9%]"
            />
            <th className="w-[15%] py-2.5 font-medium">
              <div className="flex items-center gap-2">
                <SortButton
                  label={basis === "total" ? "Total PNL" : "$ PNL"}
                  sortKey="pnlUsd"
                  sort={sort}
                  onToggle={onSort}
                  title={
                    basis === "total"
                      ? "Realized profit plus the paper value of tokens still held"
                      : "Realized profit in USD"
                  }
                />
                <SortButton
                  label="%"
                  sortKey="pnlPercent"
                  sort={sort}
                  onToggle={onSort}
                  title="PNL as a share of USD spent buying"
                />
              </div>
            </th>
            <th
              className="w-[17%] py-2.5 font-medium"
              title="Avg entry averages every token bought; avg exit covers only the tokens actually sold."
            >
              Entry → Exit
            </th>
            <th
              className="w-[16%] py-2.5 font-medium"
              title="Total USD spent buying, then total USD received selling. These cover different quantities of tokens whenever a wallet didn't sell everything it bought, so the two figures are not a round trip and their difference is not the PNL."
            >
              Bought → Sold
            </th>
            {hasHoldingData && (
              <th
                className="w-[14%] py-2.5 pr-4 font-medium xl:pr-5"
                title="Tokens still held, not yet sold"
              >
                Remaining
              </th>
            )}
          </tr>
        </thead>
        <tbody>
          {virtualize ? (
            <>
              {/* Spacer rows keep the scrollbar honest without a transform,
                  which a <tbody> can't carry reliably. */}
              <tr style={{ height: items[0]?.start ?? 0 }} aria-hidden />
              {items.map((item) => {
                const t = rows[item.index];
                return (
                  <TableRow
                    key={t.address}
                    ref={virtualizer.measureElement}
                    dataIndex={item.index}
                    row={t}
                    token={token}
                    history={histories[t.address]}
                    selected={selected.has(t.address)}
                    onToggle={onToggle}
                    onShare={onShare}
                    showMcap={showMcap}
                    basis={basis}
                    hasHoldingData={hasHoldingData}
                  />
                );
              })}
              <tr
                style={{
                  height: Math.max(
                    0,
                    virtualizer.getTotalSize() - (items[items.length - 1]?.end ?? 0)
                  ),
                }}
                aria-hidden
              />
            </>
          ) : (
            rows.map((t) => (
              <TableRow
                key={t.address}
                row={t}
                token={token}
                history={histories[t.address]}
                selected={selected.has(t.address)}
                onToggle={onToggle}
                onShare={onShare}
                showMcap={showMcap}
                basis={basis}
                hasHoldingData={hasHoldingData}
              />
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

interface RowProps {
  row: Row;
  token: TokenMeta;
  history?: WalletHistory;
  selected: boolean;
  onToggle: (address: string) => void;
  onShare: (trader: WalletTrader) => void;
  showMcap: boolean;
  basis: PnlBasis;
  hasHoldingData: boolean;
}

const TableRow = memo(function TableRow({
  ref,
  dataIndex,
  row: t,
  token,
  history,
  selected,
  onToggle,
  onShare,
  showMcap,
  basis,
  hasHoldingData,
}: RowProps & {
  ref?: (node: HTMLTableRowElement | null) => void;
  dataIndex?: number;
}) {
  return (
    <tr
      ref={ref}
      data-index={dataIndex}
      className="border-b border-neutral-900/70 transition-colors hover:bg-neutral-800/20"
    >
      <td className="py-3 pl-4 align-top xl:pl-5">
        <input
          type="checkbox"
          checked={selected}
          onChange={() => onToggle(t.address)}
          className="mt-0.5 h-3.5 w-3.5 accent-blue-500"
        />
      </td>
      <td className="py-3 align-top text-neutral-500">
        <RankBadge rank={t.rank} />
      </td>
      <td className="py-3 align-top">
        <WalletCell trader={t} history={history} onShare={onShare} />
      </td>
      <td className="py-3 align-top tabular-nums font-medium text-neutral-200">
        <span
          title={t.multipleX === null ? NO_MULTIPLE_REASON : avgXBasis(basis)}
          className="cursor-help border-b border-dotted border-neutral-700"
        >
          {t.multipleX === null ? (
            <span className="text-neutral-500">n/a</span>
          ) : (
            formatMultiple(t.multipleX)
          )}
        </span>
      </td>
      <td className="py-3 align-top tabular-nums">
        <div className={`font-semibold ${t.pnlUsd >= 0 ? "text-emerald-400" : "text-rose-400"}`}>
          {formatUsd(t.pnlUsd)}
        </div>
        <div
          className={`text-[11px] ${
            t.pnlPercent >= 0 ? "text-emerald-400/70" : "text-rose-400/70"
          }`}
        >
          {formatPercent(t.pnlPercent)}
        </div>
        <PnlSplit row={t} basis={basis} />
      </td>
      <td className="py-3 align-top tabular-nums text-neutral-300">
        <ArrowPair
          from={showMcap ? formatUsd(t.avgBuyMcapUsd) : `$${t.avgBuyPriceUsd.toPrecision(3)}`}
          to={showMcap ? formatUsd(t.avgSellMcapUsd) : `$${t.avgSellPriceUsd.toPrecision(3)}`}
        />
      </td>
      <td className="py-3 align-top tabular-nums">
        <ArrowPair from={formatUsd(t.boughtUsd)} to={formatUsd(t.soldUsd)} />
        <TokenAmounts trader={t} symbol={token.symbol} className="mt-0.5 text-[11px]" />
      </td>
      {hasHoldingData && (
        <td className="py-3 pr-4 align-top xl:pr-5">
          <RemainingCell trader={t} nativePriceUsd={token.nativePriceUsd} chain={token.chain} />
        </td>
      )}
    </tr>
  );
});

/** Mobile / tablet: one card per wallet, PNL first so nothing is buried off-screen. */
function CardList({
  rows,
  token,
  histories,
  selected,
  onToggle,
  onShare,
  showMcap,
  basis,
  hasHoldingData,
}: ListProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualize = rows.length > VIRTUALIZE_THRESHOLD;
  const virtualizer = useVirtualizer({
    count: virtualize ? rows.length : 0,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => CARD_ESTIMATE_PX,
    overscan: 8,
  });

  if (!virtualize) {
    return (
      <div className="divide-y divide-neutral-900/70">
        {rows.map((t) => (
          <TraderCard
            key={t.address}
            trader={t}
            token={token}
            history={histories[t.address]}
            showMcap={showMcap}
            basis={basis}
            hasHoldingData={hasHoldingData}
            selected={selected.has(t.address)}
            onToggle={onToggle}
            onShare={onShare}
          />
        ))}
      </div>
    );
  }

  return (
    <div ref={scrollRef} className="max-h-[75vh] overflow-y-auto">
      <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
        {virtualizer.getVirtualItems().map((item) => {
          const t = rows[item.index];
          return (
            <div
              key={t.address}
              ref={virtualizer.measureElement}
              data-index={item.index}
              className="absolute left-0 w-full border-b border-neutral-900/70"
              style={{ transform: `translateY(${item.start}px)` }}
            >
              <TraderCard
                trader={t}
                token={token}
                history={histories[t.address]}
                showMcap={showMcap}
                basis={basis}
                hasHoldingData={hasHoldingData}
                selected={selected.has(t.address)}
                onToggle={onToggle}
                onShare={onShare}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}

function StatCell({ label, value, positive }: { label: string; value: string; positive?: boolean }) {
  return (
    <div className="px-3 py-3 sm:px-5">
      <div className="text-[10px] leading-tight text-neutral-500 sm:text-[11px]">{label}</div>
      <div
        className={`mt-0.5 text-sm font-semibold tabular-nums ${
          positive === undefined ? "text-neutral-100" : positive ? "text-emerald-400" : "text-rose-400"
        }`}
      >
        {value}
      </div>
    </div>
  );
}

function Badge({ tone, children }: { tone: "emerald" | "purple" | "neutral" | "amber" | "yellow"; children: React.ReactNode }) {
  const tones: Record<typeof tone, string> = {
    emerald: "bg-emerald-500/10 text-emerald-400",
    purple: "bg-purple-500/10 text-purple-300",
    neutral: "bg-neutral-800 text-neutral-400",
    amber: "bg-amber-500/10 text-amber-300",
    yellow: "bg-yellow-500/10 text-yellow-300",
  };
  return <span className={`rounded-md px-2 py-0.5 text-[11px] font-medium ${tones[tone]}`}>{children}</span>;
}

function FilterRangeInput({
  label,
  minValue,
  maxValue,
  onMinChange,
  onMaxChange,
  minPlaceholder,
  maxPlaceholder,
}: {
  label: string;
  minValue: string;
  maxValue: string;
  onMinChange: (value: string) => void;
  onMaxChange: (value: string) => void;
  minPlaceholder: string;
  maxPlaceholder: string;
}) {
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-1 text-xs text-neutral-400 sm:flex-none">
      {label}
      <div className="flex items-center gap-1.5">
        <input
          type="number"
          inputMode="decimal"
          value={minValue}
          onChange={(e) => onMinChange(e.target.value)}
          placeholder={minPlaceholder}
          className="w-full min-w-0 rounded-lg border border-neutral-800 bg-neutral-900 px-2.5 py-1.5 text-xs text-neutral-100 outline-none focus:border-blue-500/60 focus:ring-2 focus:ring-blue-500/20 sm:w-20"
        />
        <span className="text-neutral-600">–</span>
        <input
          type="number"
          inputMode="decimal"
          value={maxValue}
          onChange={(e) => onMaxChange(e.target.value)}
          placeholder={maxPlaceholder}
          className="w-full min-w-0 rounded-lg border border-neutral-800 bg-neutral-900 px-2.5 py-1.5 text-xs text-neutral-100 outline-none focus:border-blue-500/60 focus:ring-2 focus:ring-blue-500/20 sm:w-20"
        />
      </div>
    </div>
  );
}

function hasTrackRecord(history?: WalletHistory): boolean {
  if (!history) return false;
  return history.priorTokenCount > 0 || (history.winBadges?.length ?? 0) > 0;
}

/** How many win tags render inline before the rest collapse behind "…". */
const INLINE_BADGE_LIMIT = 3;

/**
 * A wallet's proven wins on other tokens, as `[27X] $42.1K $WIF` tags. Wins
 * found by our own scans and wins discovered by the enrichment worker are the
 * same claim, so they render as one list.
 */
function HistoryBadge({ history }: { history?: WalletHistory }) {
  if (!hasTrackRecord(history) || !history) return null;

  const scanned = history.wins.map((w) =>
    formatWinBadge(w.multipleX ?? 1, w.realizedPnlUsd, w.symbol)
  );
  const all = [...scanned, ...(history.winBadges ?? [])];
  if (all.length === 0) return null;

  const inline = all.slice(0, INLINE_BADGE_LIMIT);
  const overflow = all.slice(INLINE_BADGE_LIMIT);

  return (
    <span className="inline-flex min-w-0 flex-wrap items-center gap-1">
      {inline.map((badge) => (
        <span
          key={badge}
          className="inline-flex shrink-0 items-center rounded-md bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-semibold tabular-nums text-amber-300"
        >
          {badge}
        </span>
      ))}
      {overflow.length > 0 && (
        // `group` + a hidden sibling rather than `title`, so the remaining wins
        // can be read one per line instead of as a single run-on tooltip.
        <span className="group relative inline-flex shrink-0">
          <span
            tabIndex={0}
            aria-label={`${overflow.length} more wins: ${overflow.join(", ")}`}
            className="cursor-help rounded-md bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-semibold text-amber-300/80 hover:bg-amber-500/20"
          >
            +{overflow.length}…
          </span>
          <span className="pointer-events-none absolute bottom-full left-0 z-30 mb-1 hidden w-max max-w-[16rem] flex-col gap-1 rounded-lg border border-neutral-700 bg-neutral-950/95 p-2 shadow-xl group-hover:flex group-focus-within:flex">
            {overflow.map((badge) => (
              <span key={badge} className="whitespace-nowrap text-[10px] font-semibold tabular-nums text-amber-300">
                {badge}
              </span>
            ))}
          </span>
        </span>
      )}
    </span>
  );
}

function RemainingCell({
  trader,
  nativePriceUsd,
  chain,
}: {
  trader: WalletTrader;
  nativePriceUsd: number;
  chain: Chain;
}) {
  if (trader.remainingPercent === null || trader.remainingValueUsd === null) {
    // EVM gives no balance, but a non-zero unrealized PnL still proves a position.
    if (trader.isHolding && trader.unrealizedPnlUsd !== null) {
      return (
        <div className="text-xs">
          <span className="text-neutral-400">Still holding</span>
          <div
            className={`tabular-nums ${
              trader.unrealizedPnlUsd >= 0 ? "text-emerald-400" : "text-red-400"
            }`}
          >
            {trader.unrealizedPnlUsd >= 0 ? "+" : ""}
            {formatUsd(trader.unrealizedPnlUsd)} unreal.
          </div>
        </div>
      );
    }
    return <span className="text-xs text-neutral-600">—</span>;
  }
  const remainingNative = nativePriceUsd > 0 ? trader.remainingValueUsd / nativePriceUsd : 0;
  return (
    <div>
      <div className="flex items-center justify-between gap-1.5 text-xs">
        <span className="tabular-nums text-neutral-300">
          {formatSol(remainingNative, NATIVE_UNIT[chain])}
        </span>
        <span className="tabular-nums text-neutral-500">{trader.remainingPercent.toFixed(0)}%</span>
      </div>
      {trader.isHolding && trader.unrealizedPnlUsd !== null && trader.unrealizedPnlUsd !== 0 && (
        <div
          className={`mt-0.5 text-[10px] tabular-nums ${
            trader.unrealizedPnlUsd >= 0 ? "text-emerald-400/80" : "text-red-400/80"
          }`}
        >
          {trader.unrealizedPnlUsd >= 0 ? "+" : ""}
          {formatUsd(trader.unrealizedPnlUsd)} unreal.
        </div>
      )}
      <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-neutral-800">
        <div
          className={`h-full rounded-full ${trader.isHolding ? "bg-blue-500" : "bg-neutral-600"}`}
          style={{ width: `${Math.min(100, trader.remainingPercent)}%` }}
        />
      </div>
    </div>
  );
}

function FilterIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M4 6h16M7 12h10M10 18h4" />
    </svg>
  );
}

function SortButton({
  label,
  sortKey,
  sort,
  onToggle,
  title,
}: {
  label: string;
  sortKey: SortKey;
  sort: Sort | null;
  onToggle: (key: SortKey) => void;
  title?: string;
}) {
  const active = sort?.key === sortKey ? sort.dir : null;
  return (
    <button
      onClick={() => onToggle(sortKey)}
      title={title}
      className={`group flex items-center gap-1 uppercase tracking-wide transition-colors ${
        active ? "text-blue-300" : "text-neutral-500 hover:text-neutral-300"
      }`}
    >
      {label}
      <span
        className={`text-[9px] leading-none ${
          active ? "opacity-100" : "opacity-0 group-hover:opacity-40"
        }`}
      >
        {active === "asc" ? "\u25b2" : "\u25bc"}
      </span>
    </button>
  );
}

function SortableHeader({
  className,
  ...props
}: {
  label: string;
  sortKey: SortKey;
  sort: Sort | null;
  onToggle: (key: SortKey) => void;
  title?: string;
  className?: string;
}) {
  return (
    <th className={`py-2.5 font-medium ${className ?? ""}`}>
      <SortButton {...props} />
    </th>
  );
}

function RankBadge({ rank }: { rank: number }) {
  if (rank > 3) return <span className="text-sm">{rank}</span>;
  return (
    <span
      className={`inline-flex h-5 w-5 items-center justify-center rounded-md text-[11px] font-bold ${
        rank === 1
          ? "bg-amber-400/20 text-amber-300"
          : rank === 2
          ? "bg-neutral-400/20 text-neutral-300"
          : "bg-orange-500/20 text-orange-300"
      }`}
    >
      {rank}
    </span>
  );
}

/** Spells out how much of a Total figure is still unsold, so a paper gain is
 * never mistaken for cash taken off the table. */
function PnlSplit({ row, basis }: { row: Row; basis: PnlBasis }) {
  if (basis !== "total" || row.unsoldPnlUsd === 0) return null;
  return (
    <div className="mt-0.5 text-[10px] leading-tight text-neutral-500">
      {formatUsd(row.realizedPnlUsd)} sold
      <span className="text-neutral-600"> + </span>
      {formatUsd(row.unsoldPnlUsd)} held
    </div>
  );
}

/** Omitted entirely when unknown, so a missing count never reads as "sold 0". */
function TokenAmounts({
  trader,
  symbol,
  className = "",
}: {
  trader: WalletTrader;
  symbol: string;
  className?: string;
}) {
  if (trader.boughtTokenAmount <= 0 && trader.soldTokenAmount <= 0) return null;
  const soldShare =
    trader.boughtTokenAmount > 0
      ? (Math.min(trader.soldTokenAmount, trader.boughtTokenAmount) / trader.boughtTokenAmount) * 100
      : 0;
  const movedOut = trader.transferredOutPercent ?? 0;
  return (
    <div className={`text-neutral-500 ${className}`}>
      {formatCompactNumber(trader.boughtTokenAmount)} → {formatCompactNumber(trader.soldTokenAmount)}{" "}
      {symbol}
      {/* Without this a wallet that sold 4% of its bag and moved the rest out
          looks like it dumped everything for a fraction of what it paid. */}
      {trader.boughtTokenAmount > 0 && soldShare < 99 && (
        <div className="text-neutral-600">
          sold {soldShare.toFixed(soldShare < 10 ? 1 : 0)}% of bag
          {movedOut >= 1 && (
            <span title="Left the wallet without being sold — common for wallets that split a position across addresses">
              {" "}
              · {movedOut.toFixed(0)}% moved out
            </span>
          )}
        </div>
      )}
    </div>
  );
}

function ArrowPair({ from, to }: { from: string; to: string }) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5">
      <span className="text-neutral-400">{from}</span>
      <span className="text-neutral-600">→</span>
      <span className="text-neutral-200">{to}</span>
    </div>
  );
}

function WalletCell({
  trader,
  history,
  onShare,
}: {
  trader: WalletTrader;
  history?: WalletHistory;
  onShare: (trader: WalletTrader) => void;
}) {
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1">
      {trader.tags.includes("kol") && <span title="KOL">⭐</span>}
      {trader.tags.includes("bot") && <span title="Bot">🤖</span>}
      <span className="font-mono text-xs text-neutral-200">{shortenAddress(trader.address)}</span>
      {trader.nickname && (
        <span className="truncate text-xs text-neutral-500">({trader.nickname})</span>
      )}
      <HistoryBadge history={history} />
      <button
        onClick={() => onShare(trader)}
        title="Share PNL card"
        aria-label="Share PNL card"
        className="rounded-md p-1 text-neutral-600 transition-colors hover:bg-neutral-800 hover:text-neutral-200"
      >
        <ShareIcon />
      </button>
    </div>
  );
}

const TraderCard = memo(function TraderCard({
  trader,
  token,
  history,
  showMcap,
  basis,
  hasHoldingData,
  selected,
  onToggle,
  onShare,
}: {
  trader: Row;
  token: TokenMeta;
  history?: WalletHistory;
  showMcap: boolean;
  basis: PnlBasis;
  hasHoldingData: boolean;
  selected: boolean;
  onToggle: (address: string) => void;
  onShare: (trader: WalletTrader) => void;
}) {
  const positive = trader.pnlUsd >= 0;
  return (
    <div className={`px-4 py-3.5 transition-colors ${selected ? "bg-blue-500/5" : ""}`}>
      <div className="flex items-start gap-2.5">
        <input
          type="checkbox"
          checked={selected}
          onChange={() => onToggle(trader.address)}
          className="mt-1 h-4 w-4 shrink-0 accent-blue-500"
        />
        <div className="w-6 shrink-0 pt-0.5 text-xs text-neutral-500">
          <RankBadge rank={trader.rank} />
        </div>
        <div className="min-w-0 flex-1">
          <WalletCell trader={trader} history={history} onShare={onShare} />
        </div>
        <div className="shrink-0 text-right tabular-nums">
          <div className={`text-base font-bold ${positive ? "text-emerald-400" : "text-rose-400"}`}>
            {formatUsd(trader.pnlUsd)}
          </div>
          <div className="flex items-center justify-end gap-1.5 text-[11px]">
            <span className={positive ? "text-emerald-400/70" : "text-rose-400/70"}>
              {formatPercent(trader.pnlPercent)}
            </span>
            <span className={trader.multipleX === null ? "text-neutral-500" : "font-semibold text-blue-300"}>
              {trader.multipleX === null ? "n/a" : formatMultiple(trader.multipleX)}
            </span>
          </div>
          <PnlSplit row={trader} basis={basis} />
        </div>
      </div>

      <div className="mt-2.5 grid grid-cols-2 gap-x-4 gap-y-2 pl-[3.1rem] text-xs">
        <CardField
          label={showMcap ? "Entry → Exit (mcap)" : "Entry → Exit (price)"}
          value={
            <ArrowPair
              from={showMcap ? formatUsd(trader.avgBuyMcapUsd) : `$${trader.avgBuyPriceUsd.toPrecision(3)}`}
              to={showMcap ? formatUsd(trader.avgSellMcapUsd) : `$${trader.avgSellPriceUsd.toPrecision(3)}`}
            />
          }
        />
        <CardField
          label="Bought → Sold"
          value={
            <>
              <ArrowPair from={formatUsd(trader.boughtUsd)} to={formatUsd(trader.soldUsd)} />
              <TokenAmounts trader={trader} symbol={token.symbol} className="mt-0.5 text-[10px]" />
            </>
          }
        />
        {hasHoldingData && (
          <div className="col-span-2">
            <CardField
              label="Remaining"
              value={
                <RemainingCell
                  trader={trader}
                  nativePriceUsd={token.nativePriceUsd}
                  chain={token.chain}
                />
              }
            />
          </div>
        )}
      </div>
    </div>
  );
});

function CardField({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="text-[10px] uppercase tracking-wide text-neutral-600">{label}</div>
      <div className="mt-0.5 tabular-nums">{value}</div>
    </div>
  );
}

function ShareIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="18" cy="5" r="3" />
      <circle cx="6" cy="12" r="3" />
      <circle cx="18" cy="19" r="3" />
      <path d="M8.6 13.5l6.8 3.9M15.4 6.6l-6.8 3.9" />
    </svg>
  );
}

function BackIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M19 12H5" />
      <path d="m12 19-7-7 7-7" />
    </svg>
  );
}

function DownloadIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M12 3v12M7 10l5 5 5-5M5 21h14" />
    </svg>
  );
}

function CopyIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M5 15V5a2 2 0 012-2h10" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M20 6L9 17l-5-5" />
    </svg>
  );
}
