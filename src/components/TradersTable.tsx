"use client";

import { useMemo, useState } from "react";
import type { TokenMeta, WalletHistory, WalletTrader } from "@/lib/types";
import {
  formatCompactNumber,
  formatMultiple,
  formatPercent,
  formatSol,
  formatUsd,
  shortenAddress,
} from "@/lib/format";
import { buildExportJson, copyText } from "@/lib/export";
import ExportDialog from "./ExportDialog";
import ShareCardModal from "./ShareCardModal";

interface TradersTableProps {
  token: TokenMeta;
  traders: WalletTrader[];
  isDemoData: boolean;
  histories?: Record<string, WalletHistory>;
  /** Unused while wallet-detail lookups are disabled (too costly per-click);
   * kept so callers don't need to change and it's a one-line revert to re-wire. */
  scanSession?: string;
  /** Returns to the search screen. Omit to hide the back control. */
  onBack?: () => void;
}

// Avg X is realized PNL over capital deployed, so it deliberately does not equal
// Avg Exit / Avg Entry whenever a wallet didn't sell everything it bought.
const AVG_X_BASIS =
  "Realized profit \u00f7 total USD spent buying (e.g. 1.40x = +40%). This is not Avg Exit \u00f7 Avg Entry: Avg Entry covers every token bought, while Avg Exit and the profit only cover the tokens actually sold, so the two only line up when a wallet sold its entire position.";

/** Columns the user can sort by. Each cycles desc -> asc -> off. */
type SortKey = "avgMultipleX" | "realizedPnlPercent" | "realizedPnlUsd";
type SortDir = "desc" | "asc";
interface Sort {
  key: SortKey;
  dir: SortDir;
}

interface Filters {
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
  onBack,
}: TradersTableProps) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [shareTarget, setShareTarget] = useState<WalletTrader | null>(null);
  const [showMcap, setShowMcap] = useState(true);
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [sort, setSort] = useState<Sort | null>(null);

  const matchingTraders = useMemo(() => {
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
      if (filters.provenOnly && !histories[t.address]?.priorTokenCount) return false;
      return true;
    });
  }, [traders, filters, histories]);

  // Sorting sits on top of filtering so the two compose; with no sort active the
  // list keeps the upstream ranking order.
  const filteredTraders = useMemo(() => {
    if (!sort) return matchingTraders;
    const factor = sort.dir === "desc" ? -1 : 1;
    return [...matchingTraders].sort((a, b) => (a[sort.key] - b[sort.key]) * factor);
  }, [matchingTraders, sort]);

  function toggleSort(key: SortKey) {
    setSort((prev) => {
      if (prev?.key !== key) return { key, dir: "desc" };
      if (prev.dir === "desc") return { key, dir: "asc" };
      return null;
    });
  }

  // Only Solana reports live balances; elsewhere the column would be all dashes.
  const hasHoldingData = traders.some((t) => t.isHolding !== null);

  // Wallets our own database has already caught winning on a different token.
  const provenCount = useMemo(
    () => traders.filter((t) => histories[t.address]?.priorTokenCount).length,
    [traders, histories]
  );

  // Compared against the visible rows, so filtering out a selected wallet can't
  // leave the header checkbox claiming everything is selected.
  const allSelected =
    filteredTraders.length > 0 && filteredTraders.every((t) => selected.has(t.address));

  // Summed over the filtered rows: a stats strip that describes wallets the
  // filter is hiding contradicts the table underneath it.
  const summary = useMemo(() => {
    const totalPnl = filteredTraders.reduce((sum, t) => sum + t.realizedPnlUsd, 0);
    const winners = filteredTraders.filter((t) => t.realizedPnlUsd > 0).length;
    const avgX =
      filteredTraders.length > 0
        ? filteredTraders.reduce((sum, t) => sum + t.avgMultipleX, 0) / filteredTraders.length
        : 0;
    return { totalPnl, winners, avgX };
  }, [filteredTraders]);

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

  // Export only what the user can see; exporting filtered-out rows is a surprise.
  const selectedTraders = useMemo(
    () => filteredTraders.filter((t) => selected.has(t.address)),
    [filteredTraders, selected]
  );

  const [exportTargets, setExportTargets] = useState<WalletTrader[] | null>(null);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");

  // Selecting rows narrows both buttons; otherwise they act on everything shown.
  const copyTargets = selectedTraders.length > 0 ? selectedTraders : filteredTraders;

  async function handleCopy() {
    const ok = await copyText(buildExportJson(token.symbol, copyTargets));
    setCopyState(ok ? "copied" : "failed");
    setTimeout(() => setCopyState("idle"), 2000);
  }

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
          <button
            onClick={handleCopy}
            title="Copy the export JSON to your clipboard — no download needed"
            className={`flex flex-1 items-center justify-center gap-1.5 rounded-lg border px-3 py-2 text-xs font-medium transition-colors sm:flex-none ${
              copyState === "copied"
                ? "border-emerald-700/60 bg-emerald-950/40 text-emerald-300"
                : copyState === "failed"
                ? "border-rose-800/60 bg-rose-950/40 text-rose-300"
                : "border-neutral-800 bg-neutral-900 text-neutral-200 hover:border-neutral-700 hover:bg-neutral-800"
            }`}
          >
            {copyState === "copied" ? <CheckIcon /> : <CopyIcon />}
            {copyState === "copied"
              ? "Copied!"
              : copyState === "failed"
              ? "Copy failed"
              : `Copy JSON${selected.size > 0 ? ` (${selected.size})` : ""}`}
          </button>
          <button
            onClick={() => setExportTargets(copyTargets)}
            className="flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-gradient-to-b from-blue-500 to-blue-600 px-3 py-2 text-xs font-semibold text-white shadow shadow-blue-600/20 transition-all hover:from-blue-400 hover:to-blue-500 sm:flex-none"
          >
            <DownloadIcon />
            Export{selected.size > 0 ? ` (${selected.size})` : " All"}
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
      <div className="border-b border-neutral-800/80 px-4 py-3 sm:px-5">
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
          Avg X is realized profit ÷ total USD spent buying. Avg Entry averages every token bought,
          while Avg Exit and the profit cover only the tokens actually sold — so the two line up only
          when a wallet sold its entire position.
        </p>
      </details>

      {filteredTraders.length === 0 && (
        <div className="py-12 text-center text-sm text-neutral-500">
          No traders match the current filters.
        </div>
      )}

      {/* Desktop: merged columns keep every number on screen without sideways scrolling. */}
      <div className="hidden lg:block">
        <table className="w-full table-fixed text-left text-sm">
          <thead>
            <tr className="border-b border-neutral-800/80 text-[11px] uppercase tracking-wide text-neutral-500">
              <th className="w-9 py-2.5 pl-4 xl:pl-5">
                <input
                  type="checkbox"
                  checked={allSelected}
                  onChange={toggleAll}
                  className="h-3.5 w-3.5 accent-blue-500"
                />
              </th>
              <th className="w-11 py-2.5 font-medium">#</th>
              <th className="w-[26%] py-2.5 font-medium">Wallet</th>
              <SortableHeader
                label="Avg X"
                sortKey="avgMultipleX"
                sort={sort}
                onToggle={toggleSort}
                title={AVG_X_BASIS}
                className="w-[9%]"
              />
              <th className="w-[15%] py-2.5 font-medium">
                <div className="flex items-center gap-2">
                  <SortButton
                    label="$ PNL"
                    sortKey="realizedPnlUsd"
                    sort={sort}
                    onToggle={toggleSort}
                    title="Realized profit in USD"
                  />
                  <SortButton
                    label="%"
                    sortKey="realizedPnlPercent"
                    sort={sort}
                    onToggle={toggleSort}
                    title="Realized PNL as a share of USD spent buying"
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
                title="Total USD spent buying, then total USD received selling"
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
            {filteredTraders.map((t) => (
              <tr
                key={t.address}
                className="border-b border-neutral-900/70 transition-colors hover:bg-neutral-800/20"
              >
                <td className="py-3 pl-4 align-top xl:pl-5">
                  <input
                    type="checkbox"
                    checked={selected.has(t.address)}
                    onChange={() => toggleOne(t.address)}
                    className="mt-0.5 h-3.5 w-3.5 accent-blue-500"
                  />
                </td>
                <td className="py-3 align-top text-neutral-500">
                  <RankBadge rank={t.rank} />
                </td>
                <td className="py-3 align-top">
                  <WalletCell
                    trader={t}
                    history={histories[t.address]}
                    onShare={() => setShareTarget(t)}
                  />
                </td>
                <td className="py-3 align-top tabular-nums font-medium text-neutral-200">
                  <span
                    title={AVG_X_BASIS}
                    className="cursor-help border-b border-dotted border-neutral-700"
                  >
                    {formatMultiple(t.avgMultipleX)}
                  </span>
                </td>
                <td className="py-3 align-top tabular-nums">
                  <div
                    className={`font-semibold ${
                      t.realizedPnlUsd >= 0 ? "text-emerald-400" : "text-rose-400"
                    }`}
                  >
                    {formatUsd(t.realizedPnlUsd)}
                  </div>
                  <div
                    className={`text-[11px] ${
                      t.realizedPnlPercent >= 0 ? "text-emerald-400/70" : "text-rose-400/70"
                    }`}
                  >
                    {formatPercent(t.realizedPnlPercent)}
                  </div>
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
                    <RemainingCell trader={t} nativePriceUsd={token.nativePriceUsd} />
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Mobile / tablet: one card per wallet, PNL first so nothing is buried off-screen. */}
      <div className="divide-y divide-neutral-900/70 lg:hidden">
        {filteredTraders.map((t) => (
          <TraderCard
            key={t.address}
            trader={t}
            token={token}
            history={histories[t.address]}
            showMcap={showMcap}
            hasHoldingData={hasHoldingData}
            selected={selected.has(t.address)}
            onToggle={() => toggleOne(t.address)}
            onShare={() => setShareTarget(t)}
          />
        ))}
      </div>

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

/** "Seen before" marker for wallets the database already recorded winning on other tokens. */
function HistoryBadge({ history }: { history?: WalletHistory }) {
  if (!history || history.priorTokenCount === 0) return null;
  const detail = history.wins
    .map((w) => `${formatUsd(w.realizedPnlUsd)}${w.multipleX ? ` [${w.multipleX.toFixed(0)}X]` : ""} $${w.symbol}`)
    .join("\n");
  // The best prior win is spelled out inline: the tooltip carrying the whole
  // track record is unreachable on touch devices.
  const best = history.wins[0];
  return (
    <span
      title={`Previously recorded winning on ${history.priorTokenCount} other token(s):\n${detail}`}
      className="ml-0.5 inline-flex shrink-0 cursor-help items-center gap-1 rounded-md bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-amber-300"
    >
      <span>🔥 {history.priorTokenCount}</span>
      {best && (
        <span className="hidden font-normal text-amber-200/70 sm:inline">
          {best.multipleX ? `${best.multipleX.toFixed(1)}x ` : ""}${best.symbol}
          {history.priorTokenCount > 1 ? ` +${history.priorTokenCount - 1}` : ""}
        </span>
      )}
    </span>
  );
}

function RemainingCell({ trader, nativePriceUsd }: { trader: WalletTrader; nativePriceUsd: number }) {
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
        <span className="tabular-nums text-neutral-300">{formatSol(remainingNative)}</span>
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
  return (
    <div className={`text-neutral-500 ${className}`}>
      {formatCompactNumber(trader.boughtTokenAmount)} → {formatCompactNumber(trader.soldTokenAmount)}{" "}
      {symbol}
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
  onShare: () => void;
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
        onClick={onShare}
        title="Share PNL card"
        aria-label="Share PNL card"
        className="rounded-md p-1 text-neutral-600 transition-colors hover:bg-neutral-800 hover:text-neutral-200"
      >
        <ShareIcon />
      </button>
    </div>
  );
}

function TraderCard({
  trader,
  token,
  history,
  showMcap,
  hasHoldingData,
  selected,
  onToggle,
  onShare,
}: {
  trader: WalletTrader;
  token: TokenMeta;
  history?: WalletHistory;
  showMcap: boolean;
  hasHoldingData: boolean;
  selected: boolean;
  onToggle: () => void;
  onShare: () => void;
}) {
  const positive = trader.realizedPnlUsd >= 0;
  return (
    <div className={`px-4 py-3.5 transition-colors ${selected ? "bg-blue-500/5" : ""}`}>
      <div className="flex items-start gap-2.5">
        <input
          type="checkbox"
          checked={selected}
          onChange={onToggle}
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
            {formatUsd(trader.realizedPnlUsd)}
          </div>
          <div className="flex items-center justify-end gap-1.5 text-[11px]">
            <span className={positive ? "text-emerald-400/70" : "text-rose-400/70"}>
              {formatPercent(trader.realizedPnlPercent)}
            </span>
            <span className="font-semibold text-blue-300">
              {formatMultiple(trader.avgMultipleX)}
            </span>
          </div>
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
              value={<RemainingCell trader={trader} nativePriceUsd={token.nativePriceUsd} />}
            />
          </div>
        )}
      </div>
    </div>
  );
}

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
