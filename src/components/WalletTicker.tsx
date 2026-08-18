"use client";

import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useRef, useState } from "react";
import { formatCompactNumber, formatMultiple, formatUsd } from "@/lib/format";
import type { Chain } from "@/lib/types";

interface TickerWallet {
  address: string;
  chain: Chain;
  symbol: string;
  boughtUsd: number;
  boughtNative: number | null;
  nativeSymbol: string;
  avgBuyMcapUsd: number;
  avgSellMcapUsd: number;
  multipleX: number;
  roiPercent: number;
  realizedPnlUsd: number;
  remainingPercent: number | null;
  unrealizedPnlUsd: number | null;
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

/** How long a wallet stays visible before the next one pushes in above it. */
const ROTATE_MS = 2600;
/** Rows shown at once. Bigger than a glance-able 3 on purpose — this is the
 * "look how much data we have" section. */
const VISIBLE = 10;

/** One row currently on screen. `id` is a per-insertion counter, not the
 * wallet's identity, so the same wallet cycling back through the window still
 * gets a fresh mount and replays its entrance animation. */
interface VisibleRow {
  id: number;
  wallet: TickerWallet;
}

export default function WalletTicker() {
  const [wallets, setWallets] = useState<TickerWallet[]>([]);
  const [stats, setStats] = useState<ShowcaseStats | null>(null);
  const [visible, setVisible] = useState<VisibleRow[]>([]);
  const [nativeMode, setNativeMode] = useState(false);
  const [paused, setPaused] = useState(false);
  const loaded = useRef(false);
  const pointer = useRef(0);
  const nextId = useRef(0);

  useEffect(() => {
    if (loaded.current) return;
    loaded.current = true;
    let cancelled = false;
    fetch("/api/showcase")
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (cancelled || !data) return;
        const list: TickerWallet[] = Array.isArray(data.wallets) ? data.wallets : [];
        setWallets(list);
        setStats(data.stats ?? null);
        const initial = list.slice(0, VISIBLE).map((wallet) => ({ id: nextId.current++, wallet }));
        pointer.current = initial.length;
        setVisible(initial);
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
    const id = setInterval(() => {
      const wallet = wallets[pointer.current % wallets.length];
      pointer.current += 1;
      setVisible((prev) => [{ id: nextId.current++, wallet }, ...prev].slice(0, VISIBLE));
    }, ROTATE_MS);
    return () => clearInterval(id);
  }, [paused, wallets]);

  if (visible.length === 0) return null;

  return (
    <section className="mt-8 sm:mt-12">
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
        <AnimatePresence initial={false}>
          {visible.map((row) => (
            // Keyed by insertion id, not wallet identity, so a wallet cycling
            // back through the window still mounts fresh and animates in —
            // `layout` handles the gentle downward push as new rows arrive.
            <motion.div
              key={row.id}
              layout
              initial={{ opacity: 0, y: -18, scale: 0.97 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 18, scale: 0.96 }}
              transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
            >
              <WalletRow wallet={row.wallet} nativeMode={nativeMode} />
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </section>
  );
}

function WalletRow({
  wallet,
  nativeMode,
}: {
  wallet: TickerWallet;
  nativeMode: boolean;
}) {
  const buyLabel =
    nativeMode && wallet.boughtNative !== null
      ? `${formatCompactNumber(wallet.boughtNative)} ${wallet.nativeSymbol}`
      : formatUsd(wallet.boughtUsd);

  return (
    <div className="rounded-xl border border-neutral-800/80 bg-neutral-900/40 px-4 py-3 transition-colors hover:border-neutral-700">
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

      {wallet.remainingPercent !== null && wallet.remainingPercent > 1 && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[10px]">
          <span className="rounded-md bg-blue-500/10 px-1.5 py-0.5 font-medium text-blue-300">
            still holding {wallet.remainingPercent.toFixed(0)}%
          </span>
          {wallet.unrealizedPnlUsd !== null && wallet.unrealizedPnlUsd !== 0 && (
            <span className={wallet.unrealizedPnlUsd >= 0 ? "text-emerald-400/80" : "text-red-400/80"}>
              {wallet.unrealizedPnlUsd >= 0 ? "+" : ""}
              {formatUsd(wallet.unrealizedPnlUsd)} unrealized
            </span>
          )}
        </div>
      )}

      <div className="mt-2.5 grid grid-cols-2 gap-x-4 gap-y-2 min-[420px]:grid-cols-3 sm:grid-cols-5">
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
