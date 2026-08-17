"use client";

import { useEffect, useRef, useState } from "react";
import { formatCompactNumber, formatMultiple, formatUsd } from "@/lib/format";
import type { Chain } from "@/lib/types";

interface TickerWallet {
  address: string;
  chain: Chain;
  symbol: string;
  investedUsd: number;
  investedNative: number | null;
  nativeSymbol: string;
  avgBuyMcapUsd: number;
  avgSellMcapUsd: number;
  multipleX: number;
  roiPercent: number;
  realizedPnlUsd: number;
  timesSeen: number;
  tags: string[];
  alsoWon: Array<{ symbol: string; multipleX: number | null; realizedPnlUsd: number }>;
}

interface ShowcaseStats {
  wallets: number;
  tokens: number;
  totalPnlUsd: number;
}

const CHAIN_DOT: Record<Chain, string> = {
  solana: "bg-violet-400",
  bsc: "bg-yellow-400",
  base: "bg-blue-400",
};

/** How long each wallet stays on screen. Slow on purpose — it's meant to be read. */
const ROTATE_MS = 4200;
const VISIBLE = 3;

export default function WalletTicker() {
  const [wallets, setWallets] = useState<TickerWallet[]>([]);
  const [stats, setStats] = useState<ShowcaseStats | null>(null);
  const [offset, setOffset] = useState(0);
  const [nativeMode, setNativeMode] = useState(false);
  const [paused, setPaused] = useState(false);
  const loaded = useRef(false);

  useEffect(() => {
    if (loaded.current) return;
    loaded.current = true;
    let cancelled = false;
    fetch("/api/showcase")
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (cancelled || !data) return;
        setWallets(Array.isArray(data.wallets) ? data.wallets : []);
        setStats(data.stats ?? null);
      })
      .catch(() => {
        /* the ticker is decorative; failing quietly is correct */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (paused || wallets.length <= VISIBLE) return;
    const id = setInterval(() => setOffset((o) => (o + 1) % wallets.length), ROTATE_MS);
    return () => clearInterval(id);
  }, [paused, wallets.length]);

  if (wallets.length === 0) return null;

  const visible = Array.from(
    { length: Math.min(VISIBLE, wallets.length) },
    (_, i) => wallets[(offset + i) % wallets.length]
  );

  return (
    <section className="mt-14">
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-70" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-400" />
            </span>
            <h3 className="text-sm font-semibold text-neutral-200">Wallets we&apos;re tracking</h3>
          </div>
          {stats && (
            <p className="mt-1 text-[11px] text-neutral-500">
              {formatCompactNumber(stats.wallets)} wallets across {stats.tokens} tokens ·{" "}
              <span className="text-emerald-400/90">{formatUsd(stats.totalPnlUsd)}</span> combined
              realized PNL
            </p>
          )}
        </div>

        <button
          onClick={() => setNativeMode((v) => !v)}
          className="rounded-lg border border-neutral-800 bg-neutral-900/60 px-2.5 py-1 text-[11px] font-medium text-neutral-400 transition-colors hover:border-neutral-700 hover:text-neutral-200"
          title="Switch the buy amount between USD and the chain's native coin"
        >
          Buy in: <span className="text-neutral-200">{nativeMode ? "native" : "USD"}</span>
        </button>
      </div>

      <div
        className="space-y-2"
        onMouseEnter={() => setPaused(true)}
        onMouseLeave={() => setPaused(false)}
      >
        {visible.map((w, i) => (
          <WalletRow
            key={`${w.address}-${w.symbol}-${offset + i}`}
            wallet={w}
            nativeMode={nativeMode}
          />
        ))}
      </div>

      <p className="mt-3 text-center text-[11px] text-neutral-600">
        Real wallets from previous scans · hover to pause
      </p>
    </section>
  );
}

function WalletRow({ wallet, nativeMode }: { wallet: TickerWallet; nativeMode: boolean }) {
  const buyLabel =
    nativeMode && wallet.investedNative !== null
      ? `${formatCompactNumber(wallet.investedNative)} ${wallet.nativeSymbol}`
      : formatUsd(wallet.investedUsd);

  return (
    <div
      key={wallet.address}
      className="animate-ticker-in rounded-xl border border-neutral-800/80 bg-neutral-900/40 px-4 py-3 transition-colors hover:border-neutral-700"
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${CHAIN_DOT[wallet.chain]}`} />
        {/* Already masked server-side. */}
        <span className="font-mono text-xs text-neutral-300">{wallet.address}</span>
        <span className="rounded-md bg-neutral-800/80 px-1.5 py-0.5 text-[10px] font-medium text-neutral-400">
          ${wallet.symbol}
        </span>
        {wallet.timesSeen > 1 && (
          <span className="rounded-md bg-blue-500/10 px-1.5 py-0.5 text-[10px] font-medium text-blue-300">
            seen {wallet.timesSeen}×
          </span>
        )}

        <span className="ml-auto text-sm font-semibold text-emerald-400">
          +{formatUsd(wallet.realizedPnlUsd)}
        </span>
      </div>

      <div className="mt-2.5 grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-5">
        <Stat label="Buy amount" value={buyLabel} />
        <Stat label="Avg entry" value={formatUsd(wallet.avgBuyMcapUsd)} />
        <Stat label="Avg exit" value={formatUsd(wallet.avgSellMcapUsd)} />
        <Stat label="Avg X" value={formatMultiple(wallet.multipleX)} tone="blue" />
        <Stat label="PNL %" value={`+${formatCompactNumber(wallet.roiPercent)}%`} tone="green" />
      </div>

      {wallet.alsoWon.length > 0 && (
        <div className="mt-2.5 flex flex-wrap items-center gap-1.5 border-t border-neutral-800/60 pt-2.5">
          <span className="text-[10px] uppercase tracking-wide text-neutral-600">Also won</span>
          {wallet.alsoWon.map((w) => (
            <span
              key={w.symbol}
              className="rounded-md border border-neutral-800 bg-neutral-900 px-1.5 py-0.5 text-[10px] text-neutral-400"
            >
              ${w.symbol}
              {w.multipleX ? (
                <span className="ml-1 text-blue-300">{formatMultiple(w.multipleX)}</span>
              ) : null}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "blue" | "green";
}) {
  const color =
    tone === "blue" ? "text-blue-300" : tone === "green" ? "text-emerald-400" : "text-neutral-200";
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wide text-neutral-600">{label}</div>
      <div className={`mt-0.5 text-xs font-medium tabular-nums ${color}`}>{value}</div>
    </div>
  );
}
