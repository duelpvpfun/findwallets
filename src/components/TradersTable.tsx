"use client";

import { useMemo, useState } from "react";
import type { TokenMeta, WalletTrader } from "@/lib/types";
import {
  formatDuration,
  formatMultiple,
  formatPercent,
  formatSol,
  formatUsd,
  shortenAddress,
} from "@/lib/format";
import WalletDetailModal from "./WalletDetailModal";
import ExportDialog from "./ExportDialog";

interface TradersTableProps {
  token: TokenMeta;
  traders: WalletTrader[];
  isDemoData: boolean;
}

interface Filters {
  minX: string;
  maxX: string;
  minPnlPercent: string;
  maxPnlPercent: string;
  minPnlUsd: string;
  maxPnlUsd: string;
  holdingOnly: boolean;
}

const EMPTY_FILTERS: Filters = {
  minX: "",
  maxX: "",
  minPnlPercent: "",
  maxPnlPercent: "",
  minPnlUsd: "",
  maxPnlUsd: "",
  holdingOnly: false,
};

export default function TradersTable({ token, traders, isDemoData }: TradersTableProps) {
  const [now] = useState(() => Date.now());
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [activeWallet, setActiveWallet] = useState<string | null>(null);
  const [showMcap, setShowMcap] = useState(true);
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [filtersOpen, setFiltersOpen] = useState(false);

  const filteredTraders = useMemo(() => {
    const minX = parseFloat(filters.minX);
    const maxX = parseFloat(filters.maxX);
    const minPnlPercent = parseFloat(filters.minPnlPercent);
    const maxPnlPercent = parseFloat(filters.maxPnlPercent);
    const minPnlUsd = parseFloat(filters.minPnlUsd);
    const maxPnlUsd = parseFloat(filters.maxPnlUsd);
    return traders.filter((t) => {
      if (!Number.isNaN(minX) && t.avgMultipleX < minX) return false;
      if (!Number.isNaN(maxX) && t.avgMultipleX > maxX) return false;
      if (!Number.isNaN(minPnlPercent) && t.realizedPnlPercent < minPnlPercent) return false;
      if (!Number.isNaN(maxPnlPercent) && t.realizedPnlPercent > maxPnlPercent) return false;
      if (!Number.isNaN(minPnlUsd) && t.realizedPnlUsd < minPnlUsd) return false;
      if (!Number.isNaN(maxPnlUsd) && t.realizedPnlUsd > maxPnlUsd) return false;
      if (filters.holdingOnly && t.isHolding !== true) return false;
      return true;
    });
  }, [traders, filters]);

  const hasHoldingData = traders.some((t) => t.isHolding !== null);

  const allSelected = selected.size > 0 && selected.size === filteredTraders.length;

  const summary = useMemo(() => {
    const totalPnl = traders.reduce((sum, t) => sum + t.realizedPnlUsd, 0);
    const winners = traders.filter((t) => t.realizedPnlUsd > 0).length;
    const avgX =
      traders.length > 0 ? traders.reduce((sum, t) => sum + t.avgMultipleX, 0) / traders.length : 0;
    return { totalPnl, winners, avgX };
  }, [traders]);

  function toggleAll() {
    if (allSelected) {
      setSelected(new Set());
    } else {
      setSelected(new Set(filteredTraders.map((t) => t.address)));
    }
  }

  function toggleOne(address: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(address)) next.delete(address);
      else next.add(address);
      return next;
    });
  }

  const selectedTraders = useMemo(
    () => traders.filter((t) => selected.has(t.address)),
    [traders, selected]
  );

  const [exportTargets, setExportTargets] = useState<WalletTrader[] | null>(null);

  function updateFilter<K extends keyof Filters>(key: K, value: Filters[K]) {
    setFilters((prev) => ({ ...prev, [key]: value }));
  }

  const activeFilterCount =
    (filters.minX !== "" ? 1 : 0) +
    (filters.maxX !== "" ? 1 : 0) +
    (filters.minPnlPercent !== "" ? 1 : 0) +
    (filters.maxPnlPercent !== "" ? 1 : 0) +
    (filters.minPnlUsd !== "" ? 1 : 0) +
    (filters.maxPnlUsd !== "" ? 1 : 0) +
    (filters.holdingOnly ? 1 : 0);

  return (
    <div className="overflow-hidden rounded-2xl border border-neutral-800/80 bg-neutral-900/40 shadow-xl shadow-black/10">
      {/* Token header */}
      <div className="flex flex-wrap items-start justify-between gap-4 border-b border-neutral-800/80 bg-gradient-to-b from-neutral-900/60 to-transparent px-5 py-4">
        <div className="flex items-center gap-3">
          {token.imageUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={token.imageUrl}
              alt=""
              className="h-11 w-11 rounded-full border border-neutral-800 object-cover"
            />
          ) : (
            <div className="flex h-11 w-11 items-center justify-center rounded-full bg-neutral-800 text-sm font-bold text-neutral-400">
              {token.symbol.slice(0, 2)}
            </div>
          )}
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-base font-semibold text-neutral-50">{token.name}</h2>
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

        <div className="flex items-center gap-2">
          <span className="hidden text-xs text-neutral-500 sm:inline">
            {selected.size > 0 ? `${selected.size} selected` : `${traders.length} wallets`}
          </span>
          <button
            onClick={() => setExportTargets(selectedTraders)}
            disabled={selected.size === 0}
            className="flex items-center gap-1.5 rounded-lg border border-neutral-800 bg-neutral-900 px-3 py-2 text-xs font-medium text-neutral-200 transition-colors hover:border-neutral-700 hover:bg-neutral-800 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Export Selected
          </button>
          <button
            onClick={() => setExportTargets(filteredTraders)}
            className="flex items-center gap-1.5 rounded-lg bg-gradient-to-b from-blue-500 to-blue-600 px-3 py-2 text-xs font-semibold text-white shadow shadow-blue-600/20 transition-all hover:from-blue-400 hover:to-blue-500"
          >
            <DownloadIcon />
            Export All
          </button>
        </div>
      </div>

      {/* Quick stats strip */}
      <div className="grid grid-cols-3 divide-x divide-neutral-800/80 border-b border-neutral-800/80 bg-neutral-950/40">
        <StatCell label="Combined Realized PNL" value={formatUsd(summary.totalPnl)} positive={summary.totalPnl >= 0} />
        <StatCell label="Winning Wallets" value={`${summary.winners} / ${traders.length}`} />
        <StatCell label="Avg Multiple" value={formatMultiple(summary.avgX)} />
      </div>

      {/* Filter bar */}
      <div className="border-b border-neutral-800/80 px-5 py-3">
        <div className="flex flex-wrap items-center gap-2">
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
          <div className="mt-3 flex flex-wrap items-end gap-4 rounded-xl border border-neutral-800/80 bg-neutral-950/40 p-3 animate-fade-in">
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

      <div className="overflow-x-auto">
        <table className="w-full min-w-[1100px] text-left text-sm">
          <thead>
            <tr className="border-b border-neutral-800/80 text-[11px] uppercase tracking-wide text-neutral-500">
              <th className="w-10 py-2.5 pl-5">
                <input
                  type="checkbox"
                  checked={allSelected}
                  onChange={toggleAll}
                  className="h-3.5 w-3.5 accent-blue-500"
                />
              </th>
              <th className="py-2.5 font-medium">#</th>
              <th className="py-2.5 font-medium">Wallet</th>
              <th className="py-2.5 font-medium">Last Trade</th>
              <th className="py-2.5 font-medium">Avg Entry</th>
              <th className="py-2.5 font-medium">Avg Exit</th>
              <th className="py-2.5 font-medium">Avg X</th>
              <th className="py-2.5 font-medium">% PNL</th>
              <th className="py-2.5 font-medium">$ PNL</th>
              <th className="py-2.5 pr-5 font-medium" title="Tokens still held, not yet sold">
                {hasHoldingData ? "Remaining" : "Remaining (n/a)"}
              </th>
            </tr>
          </thead>
          <tbody>
            {filteredTraders.length === 0 && (
              <tr>
                <td colSpan={9} className="py-12 text-center text-sm text-neutral-500">
                  No traders match the current filters.
                </td>
              </tr>
            )}
            {filteredTraders.map((t) => (
              <tr
                key={t.address}
                className="cursor-pointer border-b border-neutral-900/70 transition-colors hover:bg-neutral-800/30"
                onClick={() => setActiveWallet(t.address)}
              >
                <td className="py-3 pl-5" onClick={(e) => e.stopPropagation()}>
                  <input
                    type="checkbox"
                    checked={selected.has(t.address)}
                    onChange={() => toggleOne(t.address)}
                    className="h-3.5 w-3.5 accent-blue-500"
                  />
                </td>
                <td className="py-3 text-neutral-500">
                  {t.rank <= 3 ? (
                    <span
                      className={`inline-flex h-5 w-5 items-center justify-center rounded-md text-[11px] font-bold ${
                        t.rank === 1
                          ? "bg-amber-400/20 text-amber-300"
                          : t.rank === 2
                          ? "bg-neutral-400/20 text-neutral-300"
                          : "bg-orange-500/20 text-orange-300"
                      }`}
                    >
                      {t.rank}
                    </span>
                  ) : (
                    t.rank
                  )}
                </td>
                <td className="py-3">
                  <div className="flex items-center gap-1.5">
                    {t.tags.includes("kol") && <span title="KOL">⭐</span>}
                    {t.tags.includes("bot") && <span title="Bot">🤖</span>}
                    <span className="font-mono text-xs text-neutral-200">
                      {shortenAddress(t.address)}
                    </span>
                    {t.nickname && (
                      <span className="text-xs text-neutral-500">({t.nickname})</span>
                    )}
                  </div>
                </td>
                <td className="py-3 text-neutral-400">
                  {t.lastTradeMs ? `${formatDuration((now - t.lastTradeMs) / 3_600_000)} ago` : "—"}
                </td>
                <td className="py-3 tabular-nums text-neutral-300">
                  {showMcap ? formatUsd(t.avgBuyMcapUsd) : `$${t.avgBuyPriceUsd.toPrecision(3)}`}
                </td>
                <td className="py-3 tabular-nums text-neutral-300">
                  {showMcap ? formatUsd(t.avgSellMcapUsd) : `$${t.avgSellPriceUsd.toPrecision(3)}`}
                </td>
                <td className="py-3 tabular-nums font-medium text-neutral-200">
                  {formatMultiple(t.avgMultipleX)}
                </td>
                <td
                  className={`py-3 tabular-nums font-medium ${
                    t.realizedPnlPercent >= 0 ? "text-emerald-400" : "text-rose-400"
                  }`}
                >
                  {formatPercent(t.realizedPnlPercent)}
                </td>
                <td
                  className={`py-3 tabular-nums font-medium ${
                    t.realizedPnlUsd >= 0 ? "text-emerald-400" : "text-rose-400"
                  }`}
                >
                  {formatUsd(t.realizedPnlUsd)}
                </td>
                <td className="py-3 pr-5">
                  <RemainingCell trader={t} nativePriceUsd={token.nativePriceUsd} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {activeWallet && (
        <WalletDetailModal
          chain={token.chain}
          tokenAddress={token.address}
          tokenName={token.name}
          estimatedSupply={token.estimatedSupply}
          nativePriceUsd={token.nativePriceUsd}
          trader={traders.find((t) => t.address === activeWallet)!}
          onClose={() => setActiveWallet(null)}
        />
      )}

      {exportTargets && (
        <ExportDialog
          tokenName={token.name}
          tokenSymbol={token.symbol}
          traders={exportTargets}
          onClose={() => setExportTargets(null)}
        />
      )}
    </div>
  );
}

function StatCell({ label, value, positive }: { label: string; value: string; positive?: boolean }) {
  return (
    <div className="px-5 py-3">
      <div className="text-[11px] text-neutral-500">{label}</div>
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
    <div className="flex flex-col gap-1 text-xs text-neutral-400">
      {label}
      <div className="flex items-center gap-1.5">
        <input
          type="number"
          value={minValue}
          onChange={(e) => onMinChange(e.target.value)}
          placeholder={minPlaceholder}
          className="w-20 rounded-lg border border-neutral-800 bg-neutral-900 px-2.5 py-1.5 text-xs text-neutral-100 outline-none focus:border-blue-500/60 focus:ring-2 focus:ring-blue-500/20"
        />
        <span className="text-neutral-600">–</span>
        <input
          type="number"
          value={maxValue}
          onChange={(e) => onMaxChange(e.target.value)}
          placeholder={maxPlaceholder}
          className="w-20 rounded-lg border border-neutral-800 bg-neutral-900 px-2.5 py-1.5 text-xs text-neutral-100 outline-none focus:border-blue-500/60 focus:ring-2 focus:ring-blue-500/20"
        />
      </div>
    </div>
  );
}

function RemainingCell({ trader, nativePriceUsd }: { trader: WalletTrader; nativePriceUsd: number }) {
  if (trader.remainingPercent === null || trader.remainingValueUsd === null) {
    return <span className="text-xs text-neutral-600">—</span>;
  }
  const remainingNative = nativePriceUsd > 0 ? trader.remainingValueUsd / nativePriceUsd : 0;
  return (
    <div className="min-w-[110px]">
      <div className="flex items-center justify-between text-xs">
        <span className="tabular-nums text-neutral-300">{formatSol(remainingNative)}</span>
        <span className="tabular-nums text-neutral-500">{trader.remainingPercent.toFixed(0)}%</span>
      </div>
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

function DownloadIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M12 3v12M7 10l5 5 5-5M5 21h14" />
    </svg>
  );
}
