"use client";

import { useEffect, useMemo, useState } from "react";
import { buildExportEntries, DEFAULT_EXPORT_OPTIONS, type NameStyle } from "@/lib/export";
import { formatMultiple, formatUsd, shortenAddress } from "@/lib/format";
import { PREVIEW_DISMISSED_KEY } from "@/lib/tiers";
import type { WalletTrader } from "@/lib/types";

/**
 * Welcome dialog showing the wallet table, selection, and the exact JSON the
 * export produces. The JSON comes from the real `buildExportEntries` used by
 * the live export, so what's shown here is byte-for-byte what downloads —
 * nothing is mocked up. Dismissable, and skippable for good via localStorage.
 */

/** Shape-complete rows so the preview runs the genuine export code path. */
function trader(
  rank: number,
  address: string,
  nickname: string | null,
  realizedPnlUsd: number,
  avgMultipleX: number,
  avgBuyMcapUsd: number,
  avgSellMcapUsd: number
): WalletTrader {
  return {
    rank,
    address,
    nickname,
    twitter: null,
    tags: [],
    avgBuyPriceUsd: 0,
    avgSellPriceUsd: 0,
    avgBuyMcapUsd,
    avgSellMcapUsd,
    buyTxns: 0,
    sellTxns: 0,
    boughtTokenAmount: 0,
    soldTokenAmount: 0,
    boughtUsd: 0,
    soldUsd: 0,
    realizedPnlUsd,
    realizedPnlPercent: 0,
    avgMultipleX,
    remainingPercent: null,
    remainingValueUsd: null,
    isHolding: null,
    unrealizedPnlUsd: null,
    lastTradeMs: null,
    firstTradeMs: null,
    walletLifetimeRealizedPnlUsd: null,
    walletLifetimeTotalTrades: null,
    walletLifetimeTokensTraded: null,
  };
}

const SAMPLE_SYMBOL = "TRUMP";
const SAMPLE: WalletTrader[] = [
  trader(1, "C5tTsPXvfmBQ9qFjyRAMyDpDgLmvhJRnZ4XkKnFsmsxu", null, 26_778_745, 14.1, 2.54e9, 3.57e10),
  trader(2, "GybhvUZzKN8xkRcqPmQ7dLwTtVnJhFo3aBcDeFgHYeHK", "cupsey", 19_215_949, 19.7, 2.81e9, 5.54e10),
  trader(3, "CWvdyvKHEu8Z1TbTruorJYnTGyD6bmqZ2ncNQnP1C8ou", null, 17_854_230, 77.6, 4.67e8, 3.62e10),
  trader(4, "7PypumL2CJRvoVSVAsx6uMkFxfBiPqYbEfnJRvA1uz8R", null, 22_468_908, 13.7, 3.63e9, 4.98e10),
];

const NAME_STYLES: Array<{ value: NameStyle; label: string }> = [
  { value: "multiple", label: "Multiple" },
  { value: "pnl", label: "PNL" },
  { value: "rank", label: "Rank" },
  { value: "address", label: "Address" },
];

export default function ProductPreview({ onClose }: { onClose: () => void }) {
  const [selected, setSelected] = useState<string[]>(SAMPLE.map((t) => t.address));
  const [nameStyle, setNameStyle] = useState<NameStyle>("multiple");
  const [group, setGroup] = useState("Main");
  const [dontShowAgain, setDontShowAgain] = useState(false);

  function dismiss() {
    if (dontShowAgain) {
      try {
        localStorage.setItem(PREVIEW_DISMISSED_KEY, "1");
      } catch {
        // Private browsing can reject writes; closing the dialog still matters more.
      }
    }
    onClose();
  }

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      if (dontShowAgain) {
        try {
          localStorage.setItem(PREVIEW_DISMISSED_KEY, "1");
        } catch {
          // Private browsing can reject writes; closing still matters more.
        }
      }
      onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dontShowAgain, onClose]);

  const chosen = SAMPLE.filter((t) => selected.includes(t.address));

  // The real export builder — same function the download button calls.
  const json = useMemo(
    () =>
      JSON.stringify(
        buildExportEntries(SAMPLE_SYMBOL, chosen, {
          ...DEFAULT_EXPORT_OPTIONS,
          nameStyle,
          group,
        }),
        null,
        2
      ),
    [chosen, nameStyle, group]
  );

  function toggle(address: string) {
    setSelected((prev) =>
      prev.includes(address) ? prev.filter((a) => a !== address) : [...prev, address]
    );
  }

  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm animate-fade-in"
      onClick={dismiss}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Export preview"
        onClick={(e) => e.stopPropagation()}
        className="max-h-[90vh] w-full max-w-4xl overflow-y-auto rounded-2xl border border-neutral-800 bg-neutral-950 p-5 shadow-2xl shadow-black/50"
      >
        <div className="mb-4 flex items-start justify-between gap-4">
          <div>
            <h3 className="text-sm font-semibold text-neutral-100">
              Take the winners straight to your tracker
            </h3>
            <p className="mt-1 text-[11px] text-neutral-500">
              Pick the wallets you want and they export in your bot&apos;s format. Have a play —
              this panel is live.
            </p>
          </div>
          <button
            onClick={dismiss}
            aria-label="Close"
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-neutral-800 text-neutral-500 transition-colors hover:border-neutral-700 hover:text-neutral-200"
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="grid gap-3 lg:grid-cols-2">
        {/* Selection side */}
        <div className="overflow-hidden rounded-xl border border-neutral-800 bg-neutral-900/40">
          <div className="flex items-center justify-between border-b border-neutral-800 px-4 py-2.5">
            <span className="text-[11px] font-medium text-neutral-400">
              {chosen.length} of {SAMPLE.length} selected
            </span>
            <button
              onClick={() =>
                setSelected(
                  selected.length === SAMPLE.length ? [] : SAMPLE.map((t) => t.address)
                )
              }
              className="text-[11px] text-blue-400 hover:text-blue-300"
            >
              {selected.length === SAMPLE.length ? "Clear all" : "Select all"}
            </button>
          </div>

          <div className="divide-y divide-neutral-800/70">
            {SAMPLE.map((t) => {
              const isOn = selected.includes(t.address);
              return (
                <button
                  key={t.address}
                  onClick={() => toggle(t.address)}
                  className={`flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors ${
                    isOn ? "bg-blue-500/5" : "hover:bg-neutral-900/60"
                  }`}
                >
                  <span
                    className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border ${
                      isOn ? "border-blue-500 bg-blue-500" : "border-neutral-700"
                    }`}
                  >
                    {isOn && (
                      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="4">
                        <path d="M20 6L9 17l-5-5" />
                      </svg>
                    )}
                  </span>
                  <span className="w-5 text-[11px] text-neutral-600">#{t.rank}</span>
                  <span className="font-mono text-xs text-neutral-300">
                    {t.nickname ?? shortenAddress(t.address, 4)}
                  </span>
                  <span className="ml-auto text-xs font-medium text-blue-300">
                    {formatMultiple(t.avgMultipleX)}
                  </span>
                  <span className="w-16 text-right text-xs font-semibold text-emerald-400">
                    {formatUsd(t.realizedPnlUsd)}
                  </span>
                </button>
              );
            })}
          </div>

          <div className="flex flex-wrap items-center gap-2 border-t border-neutral-800 px-4 py-3">
            <span className="text-[11px] text-neutral-500">Name by</span>
            {NAME_STYLES.map((s) => (
              <button
                key={s.value}
                onClick={() => setNameStyle(s.value)}
                className={`rounded-md px-2 py-0.5 text-[11px] transition-colors ${
                  nameStyle === s.value
                    ? "bg-neutral-700 text-neutral-100"
                    : "text-neutral-500 hover:text-neutral-300"
                }`}
              >
                {s.label}
              </button>
            ))}
            <input
              value={group}
              onChange={(e) => setGroup(e.target.value)}
              placeholder="Group"
              maxLength={24}
              className="ml-auto w-24 rounded-md border border-neutral-800 bg-neutral-950 px-2 py-1 text-[11px] text-neutral-200 outline-none focus:border-neutral-600"
            />
          </div>
        </div>

        {/* Export side */}
        <div className="overflow-hidden rounded-xl border border-neutral-800 bg-neutral-950">
          <div className="flex items-center justify-between border-b border-neutral-800 px-4 py-2.5">
            <span className="font-mono text-[11px] text-neutral-400">
              highpnl-{SAMPLE_SYMBOL.toLowerCase()}.json
            </span>
            <span className="rounded-md bg-neutral-800 px-1.5 py-0.5 text-[10px] text-neutral-400">
              live output
            </span>
          </div>
            <pre className="max-h-[19rem] overflow-auto px-4 py-3 text-[11px] leading-relaxed text-neutral-400">
              <code>{chosen.length > 0 ? json : "// select at least one wallet"}</code>
            </pre>
          </div>
        </div>

        <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
          <label className="flex cursor-pointer items-center gap-2 text-[11px] text-neutral-500 hover:text-neutral-400">
            <input
              type="checkbox"
              checked={dontShowAgain}
              onChange={(e) => setDontShowAgain(e.target.checked)}
              className="h-3.5 w-3.5 accent-blue-500"
            />
            Don&apos;t show this again
          </label>
          <button
            onClick={dismiss}
            className="rounded-lg bg-gradient-to-b from-blue-500 to-blue-600 px-4 py-2 text-xs font-semibold text-white shadow shadow-blue-600/20 transition-all hover:from-blue-400 hover:to-blue-500"
          >
            Got it
          </button>
        </div>
      </div>
    </div>
  );
}
