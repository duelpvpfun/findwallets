"use client";

import { useEffect, useState } from "react";
import type { Chain, WalletDetail, WalletTrader } from "@/lib/types";
import { buildWalletDetail } from "@/lib/mockData";
import { OWNER_STORAGE_KEY } from "@/lib/tiers";
import {
  NATIVE_UNIT,
  formatCompactNumber,
  formatDuration,
  formatMultiple,
  formatPercent,
  formatSol,
  formatUsd,
  shortenAddress,
} from "@/lib/format";

// Avg Multiple is realized PNL over the cost of the tokens actually sold, so it
// deliberately does not equal Avg Exit / Avg Entry whenever a wallet didn't sell
// everything it bought.
const AVG_X_BASIS =
  "Realized profit ÷ the USD cost of the tokens actually sold. Not Avg Exit ÷ Avg Entry: Avg Entry averages every token bought, including any the wallet still holds.";

interface WalletDetailModalProps {
  chain: Chain;
  tokenAddress: string;
  tokenName: string;
  estimatedSupply: number;
  nativePriceUsd: number;
  /** Proves this scan was paid for; required by the wallet-detail endpoint. */
  scanSession?: string;
  trader: WalletTrader;
  onClose: () => void;
}

export default function WalletDetailModal({
  chain,
  tokenAddress,
  tokenName,
  estimatedSupply,
  nativePriceUsd,
  scanSession,
  trader,
  onClose,
}: WalletDetailModalProps) {
  const [now] = useState(() => Date.now());
  const [detail, setDetail] = useState<WalletDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [showMcap, setShowMcap] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const query = new URLSearchParams({
      token: tokenAddress,
      wallet: trader.address,
      estimatedSupply: String(estimatedSupply),
      chain,
    });
    const ownerKey = typeof window === "undefined" ? null : localStorage.getItem(OWNER_STORAGE_KEY);
    const headers: Record<string, string> = {};
    if (scanSession) headers["x-scan-session"] = scanSession;
    if (ownerKey) headers["x-owner-key"] = ownerKey;

    fetch(`/api/wallet-detail?${query.toString()}`, { headers })
      .then((r) => r.json())
      .then((data) => {
        if (cancelled) return;
        if (data.error === "not_configured") {
          setDetail(buildWalletDetail(tokenAddress, trader));
          return;
        }
        if (data.error) {
          setError(data.error);
          return;
        }
        setDetail(data as WalletDetail);
      })
      .catch(() => {
        if (!cancelled) setError("Failed to load wallet detail.");
      });
    return () => {
      cancelled = true;
    };
  }, [tokenAddress, trader, estimatedSupply, chain, scanSession]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  function copyAddress() {
    navigator.clipboard.writeText(trader.address).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    });
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm animate-fade-in"
      onClick={onClose}
    >
      <div
        className="flex max-h-[90vh] w-full max-w-5xl flex-col overflow-hidden rounded-2xl border border-neutral-800 bg-neutral-950 shadow-2xl shadow-black/50"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-neutral-800 bg-gradient-to-b from-neutral-900/60 to-transparent px-5 py-4">
          <div className="flex items-center gap-2.5">
            <div className="flex h-9 w-9 items-center justify-center rounded-full bg-neutral-800 text-sm">
              {trader.tags.includes("kol") ? "⭐" : trader.tags.includes("bot") ? "🤖" : "👛"}
            </div>
            <div>
              <div className="flex items-center gap-2">
                {trader.nickname && (
                  <span className="text-sm font-semibold text-neutral-100">{trader.nickname}</span>
                )}
                <button
                  onClick={copyAddress}
                  className="flex items-center gap-1 rounded-md bg-neutral-900 px-2 py-1 font-mono text-xs text-neutral-300 transition-colors hover:bg-neutral-800"
                  title="Copy address"
                >
                  {shortenAddress(trader.address, 6)}
                  <CopyIcon />
                </button>
                {copied && <span className="text-xs text-emerald-400">Copied</span>}
              </div>
              <div className="mt-0.5 flex items-center gap-2">
                {(detail?.twitter ?? trader.twitter) && (
                  <a
                    href={`https://x.com/${(detail?.twitter ?? trader.twitter)!.replace(/^@/, "")}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs text-blue-400 hover:underline"
                  >
                    {detail?.twitter ?? trader.twitter}
                  </a>
                )}
                {detail?.isDemoData && (
                  <span className="rounded-md bg-yellow-500/10 px-2 py-0.5 text-[11px] font-medium text-yellow-300">
                    Demo data
                  </span>
                )}
              </div>
            </div>
          </div>
          <button
            onClick={onClose}
            className="rounded-lg p-1.5 text-neutral-400 transition-colors hover:bg-neutral-800 hover:text-neutral-200"
            aria-label="Close"
          >
            <CloseIcon />
          </button>
        </div>

        <div className="overflow-y-auto px-5 py-5">
          {error && (
            <div className="rounded-xl border border-rose-900/60 bg-rose-950/30 px-4 py-3 text-sm text-rose-300">
              {error}
            </div>
          )}
          {!detail && !error ? (
            <div className="flex h-64 flex-col items-center justify-center gap-3 text-neutral-500">
              <Spinner />
              Loading wallet…
            </div>
          ) : detail ? (
            <>
              {/* Top summary cards */}
              <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
                <Card title="Wallet Value">
                  {detail.totalValueUsd !== null ? (
                    <>
                      <div className="text-2xl font-semibold tabular-nums text-neutral-50">
                        {formatUsd(detail.totalValueUsd)}
                      </div>
                      <div className="mt-1 text-xs text-neutral-500">{NATIVE_UNIT[chain]} Balance</div>
                      <div className="text-sm font-medium tabular-nums text-neutral-300">
                        {detail.nativeBalance?.toFixed(2)} {NATIVE_UNIT[chain]}
                      </div>
                    </>
                  ) : (
                    <div className="text-sm text-neutral-500">
                      Wallet balance isn&apos;t available on {chain === "bsc" ? "BNB Chain" : "Base"} yet.
                    </div>
                  )}
                  {detail.avgHoldTimeSecs !== null && (
                    <>
                      <Divider />
                      <Row label="Avg Hold Time" value={formatDuration(detail.avgHoldTimeSecs / 3600)} />
                    </>
                  )}
                </Card>

                <Card title="Wallet Lifetime PNL">
                  <div
                    className={`text-2xl font-semibold tabular-nums ${
                      detail.walletRealizedPnlUsd >= 0 ? "text-emerald-400" : "text-rose-400"
                    }`}
                  >
                    {formatUsd(detail.walletRealizedPnlUsd)}
                  </div>
                  <div className="mt-1 text-xs text-neutral-500">Unrealized</div>
                  <div
                    className={`text-sm font-medium tabular-nums ${
                      detail.walletUnrealizedPnlUsd >= 0 ? "text-emerald-400" : "text-rose-400"
                    }`}
                  >
                    {formatUsd(detail.walletUnrealizedPnlUsd)}
                  </div>
                  <Divider />
                  <Row
                    label="Win Rate"
                    value={detail.winRatePercent !== null ? `${detail.winRatePercent.toFixed(0)}%` : "—"}
                  />
                  {detail.platforms.length > 0 && (
                    <Row label="Platform" value={detail.platforms.join(", ")} />
                  )}
                </Card>

                <Card title="ROI Distribution (closed)">
                  {detail.positionsHolding !== null && detail.positionsSold !== null && (
                    <Row
                      label="Positions"
                      value={`${detail.positionsHolding} holding / ${detail.positionsSold} sold`}
                    />
                  )}
                  {detail.tokensWinning !== null && detail.tokensLosing !== null && (
                    <Row
                      label="Closed W/L"
                      value={
                        <>
                          <span className="text-emerald-400">{detail.tokensWinning}</span>/
                          <span className="text-rose-400">{detail.tokensLosing}</span>
                        </>
                      }
                    />
                  )}
                  {detail.distribution.length > 0 ? (
                    <div className="mt-3 space-y-1.5">
                      {detail.distribution.map((bucket) => {
                        const isLoss = bucket.label.startsWith("<") || bucket.label.includes("-50");
                        const max = Math.max(...detail.distribution.map((d) => d.count), 1);
                        return (
                          <div key={bucket.label} className="flex items-center gap-2 text-[11px]">
                            <span className="w-16 shrink-0 text-neutral-500">{bucket.label}</span>
                            <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-neutral-800">
                              <div
                                className={`h-full rounded-full ${isLoss ? "bg-rose-500" : "bg-emerald-500"}`}
                                style={{ width: `${(bucket.count / max) * 100}%` }}
                              />
                            </div>
                            <span className="w-5 shrink-0 text-right text-neutral-400">{bucket.count}</span>
                          </div>
                        );
                      })}
                    </div>
                  ) : (
                    <div className="mt-2 text-sm text-neutral-500">Not available on this chain.</div>
                  )}
                </Card>
              </div>

              {/* This-token performance */}
              <div className="mt-4 rounded-xl border border-neutral-800 bg-neutral-900/40 p-4">
                <div className="mb-3 flex items-center justify-between">
                  <div className="text-xs font-medium uppercase tracking-wide text-neutral-500">
                    Performance on {tokenName}
                  </div>
                  <div className="flex overflow-hidden rounded-lg border border-neutral-800 text-xs font-medium">
                    <button
                      onClick={() => setShowMcap(true)}
                      className={`px-2.5 py-1 transition-colors ${
                        showMcap ? "bg-blue-500/20 text-blue-300" : "bg-neutral-900 text-neutral-500"
                      }`}
                    >
                      Mcap
                    </button>
                    <button
                      onClick={() => setShowMcap(false)}
                      className={`px-2.5 py-1 transition-colors ${
                        !showMcap ? "bg-blue-500/20 text-blue-300" : "bg-neutral-900 text-neutral-500"
                      }`}
                    >
                      Price
                    </button>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                  <Stat
                    label="Avg Entry (all buys)"
                    value={showMcap ? formatUsd(trader.avgBuyMcapUsd) : `$${trader.avgBuyPriceUsd.toPrecision(3)}`}
                    title="Volume-weighted average across every buy — includes tokens the wallet never sold."
                  />
                  <Stat
                    label="Avg Exit (sold only)"
                    value={showMcap ? formatUsd(trader.avgSellMcapUsd) : `$${trader.avgSellPriceUsd.toPrecision(3)}`}
                    title="Volume-weighted average across every sell — covers only the tokens actually sold."
                  />
                  <Stat
                    label="Avg Multiple"
                    value={formatMultiple(trader.avgMultipleX)}
                    title={AVG_X_BASIS}
                  />
                  <Stat
                    label="% PNL"
                    value={formatPercent(trader.realizedPnlPercent)}
                    positive={trader.realizedPnlPercent >= 0}
                  />
                  <Stat
                    label="$ PNL"
                    value={formatUsd(trader.realizedPnlUsd)}
                    positive={trader.realizedPnlUsd >= 0}
                  />
                  <Stat label="Bought" value={formatUsd(trader.boughtUsd)} />
                  <Stat label="Sold" value={formatUsd(trader.soldUsd)} />
                </div>

                {trader.remainingPercent !== null && trader.remainingValueUsd !== null && (
                  <div className="mt-4 border-t border-neutral-800/80 pt-3">
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-neutral-500" title="Tokens still held, not yet sold">
                        Remaining Position {trader.isHolding ? "(still holding)" : "(fully exited)"}
                      </span>
                      <span className="tabular-nums text-neutral-300">
                        {formatSol(
                          nativePriceUsd > 0 ? trader.remainingValueUsd / nativePriceUsd : 0,
                          NATIVE_UNIT[chain]
                        )}{" "}
                        · {trader.remainingPercent.toFixed(0)}% of what they bought
                      </span>
                    </div>
                    <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-neutral-800">
                      <div
                        className={`h-full rounded-full ${trader.isHolding ? "bg-blue-500" : "bg-neutral-600"}`}
                        style={{ width: `${Math.min(100, trader.remainingPercent)}%` }}
                      />
                    </div>
                  </div>
                )}
              </div>

              {/* Track record on other tokens */}
              <div className="mt-4">
                <div className="mb-2 flex items-baseline justify-between border-b border-neutral-800 pb-2">
                  <span className="text-sm font-medium text-neutral-100">Best trades on other tokens</span>
                  <span className="text-[11px] text-neutral-500">
                    Is this wallet consistently profitable?
                  </span>
                </div>
                <div className="overflow-x-auto rounded-lg border border-neutral-800/80">
                  <table className="w-full min-w-[560px] text-left text-sm">
                    <thead>
                      <tr className="border-b border-neutral-800/80 bg-neutral-900/40 text-[11px] uppercase tracking-wide text-neutral-500">
                        <th className="py-2 pl-3 font-medium">Token</th>
                        <th
                          className="py-2 font-medium"
                          title="Volume-weighted average across every buy — includes tokens the wallet never sold."
                        >
                          Avg Entry <span className="text-neutral-600 normal-case">(all buys)</span>
                        </th>
                        <th
                          className="py-2 font-medium"
                          title="Volume-weighted average across every sell — covers only the tokens actually sold."
                        >
                          Avg Exit <span className="text-neutral-600 normal-case">(sold)</span>
                        </th>
                        <th className="py-2 font-medium" title={AVG_X_BASIS}>
                          X
                        </th>
                        <th className="py-2 font-medium">% PNL</th>
                        <th className="py-2 pr-3 font-medium">$ PNL</th>
                      </tr>
                    </thead>
                    <tbody>
                      {detail.topPositions.length === 0 && (
                        <tr>
                          <td colSpan={6} className="py-6 text-center text-neutral-500">
                            No other token history found for this wallet.
                          </td>
                        </tr>
                      )}
                      {detail.topPositions.map((p) => (
                        <tr key={p.tokenAddress} className="border-t border-neutral-900 text-neutral-300">
                          <td className="py-2 pl-3 font-medium text-neutral-200">{p.symbol}</td>
                          <td className="py-2 tabular-nums">${p.avgBuyPriceUsd.toPrecision(3)}</td>
                          <td className="py-2 tabular-nums">${p.avgSellPriceUsd.toPrecision(3)}</td>
                          <td className="py-2 tabular-nums">{formatMultiple(p.multipleX)}</td>
                          <td
                            className={`py-2 tabular-nums font-medium ${
                              p.roiPercent >= 0 ? "text-emerald-400" : "text-rose-400"
                            }`}
                          >
                            {formatPercent(p.roiPercent)}
                          </td>
                          <td
                            className={`py-2 pr-3 tabular-nums font-medium ${
                              p.realizedPnlUsd >= 0 ? "text-emerald-400" : "text-rose-400"
                            }`}
                          >
                            {formatUsd(p.realizedPnlUsd)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Activity table */}
              <div className="mt-4">
                <div className="mb-2 border-b border-neutral-800 pb-2 text-sm font-medium text-neutral-100">
                  Activity on {tokenName}
                </div>
                <div className="overflow-x-auto rounded-lg border border-neutral-800/80">
                  <table className="w-full min-w-[500px] text-left text-sm">
                    <thead>
                      <tr className="border-b border-neutral-800/80 bg-neutral-900/40 text-[11px] uppercase tracking-wide text-neutral-500">
                        <th className="py-2 pl-3 font-medium">Type</th>
                        <th className="py-2 font-medium">Amount</th>
                        <th className="py-2 font-medium">{showMcap ? "Market Cap" : "Price"}</th>
                        <th className="py-2 pr-3 font-medium">Age</th>
                      </tr>
                    </thead>
                    <tbody>
                      {detail.activity.length === 0 && (
                        <tr>
                          <td colSpan={4} className="py-6 text-center text-neutral-500">
                            No recent trades found.
                          </td>
                        </tr>
                      )}
                      {detail.activity.map((row) => (
                        <tr key={row.txSignature} className="border-t border-neutral-900 text-neutral-300">
                          <td
                            className={`py-2 pl-3 font-medium ${
                              row.type === "Buy" ? "text-emerald-400" : "text-rose-400"
                            }`}
                          >
                            {row.type}
                          </td>
                          <td className="py-2 tabular-nums">{formatCompactNumber(row.amountTokens)}</td>
                          <td className="py-2 tabular-nums">
                            {showMcap ? formatUsd(row.mcapUsd) : `$${row.priceUsd.toPrecision(3)}`}
                          </td>
                          <td className="py-2 pr-3 text-neutral-500">
                            {formatDuration((now - row.timeMs) / 3_600_000)} ago
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-neutral-800 bg-neutral-900/40 p-4">
      <div className="mb-2 text-xs text-neutral-500">{title}</div>
      {children}
    </div>
  );
}

function Divider() {
  return <div className="my-3 h-px bg-neutral-800/80" />;
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between text-xs">
      <span className="text-neutral-500">{label}</span>
      <span className="tabular-nums text-neutral-300">{value}</span>
    </div>
  );
}

function Stat({
  label,
  value,
  positive,
  title,
}: {
  label: string;
  value: string;
  positive?: boolean;
  title?: string;
}) {
  return (
    <div title={title} className={title ? "cursor-help" : undefined}>
      <div className="text-[11px] text-neutral-500">{label}</div>
      <div
        className={`text-sm font-semibold tabular-nums ${
          positive === undefined
            ? "text-neutral-100"
            : positive
            ? "text-emerald-400"
            : "text-rose-400"
        }`}
      >
        {value}
      </div>
    </div>
  );
}

function Spinner() {
  return (
    <svg className="h-6 w-6 animate-spin text-blue-400" viewBox="0 0 24 24" fill="none">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
      <path className="opacity-90" fill="currentColor" d="M4 12a8 8 0 018-8v3a5 5 0 00-5 5H4z" />
    </svg>
  );
}

function CopyIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="9" y="9" width="13" height="13" rx="2" />
      <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M18 6L6 18M6 6l12 12" />
    </svg>
  );
}
