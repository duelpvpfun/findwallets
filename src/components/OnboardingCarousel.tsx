"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { buildExportEntries, DEFAULT_EXPORT_OPTIONS } from "@/lib/export";
import { formatMultiple, formatUsd, shortenAddress } from "@/lib/format";
import { ONBOARDING_DISMISSED_KEY, PREVIEW_DISMISSED_KEY } from "@/lib/tiers";
import { useFocusTrap } from "@/lib/useFocusTrap";
import { useReducedMotion } from "@/lib/useReducedMotion";
import type { Chain, TokenMeta, WalletTrader } from "@/lib/types";
import RadarSweep from "./RadarSweep";

/**
 * First-run walkthrough: paste an address, watch the scan, read the ranking,
 * export the JSON, then run one for free.
 *
 * Every wallet address, multiple and PNL on these panels is REAL — pulled from
 * `/api/preview`, which replays a scan already stored in our database. Nothing
 * here is a screenshot and nothing is invented: a plausible-looking fake wallet
 * would be read as a real one, and a screenshot is wrong the day the UI changes.
 * When the preview is unavailable the panels render their chrome with no figures
 * at all rather than filling in placeholders.
 *
 * The final panel is the product: it runs a genuine free scan on a token the
 * visitor picks, so the paywall arrives after they have seen it work.
 */

/** A token we've already scanned, replayable as a free sample. */
export interface OnboardingSample {
  chain: Chain;
  address: string;
  symbol: string;
  name: string;
  walletCount: number;
}

interface PreviewData {
  token: TokenMeta;
  traders: WalletTrader[];
}

interface OnboardingCarouselProps {
  /** Free samples from `/api/showcase`. May arrive after the first render. */
  samples: OnboardingSample[];
  onClose: () => void;
  /** Close and replay the full free sample in the main table. */
  onRunSample: (sample: OnboardingSample) => void;
  /** Close and drop this address into the search bar, ready to scan. */
  onUseAddress: (address: string) => void;
}

const AUTO_ADVANCE_MS = 5000;
/** How many real rows the ranking and export panels show. */
const PANEL_ROWS = 5;
/** Ignore a horizontal drag shorter than this — it was a scroll, not a swipe. */
const SWIPE_THRESHOLD_PX = 44;
/** How many "pages" the replayed scan arrives in. */
const REVEAL_PAGES = 8;

type PanelId = "paste" | "scan" | "rank" | "export" | "try";

const PANELS: Array<{ id: PanelId; step: string; title: string }> = [
  { id: "paste", step: "Paste", title: "Paste a contract address" },
  { id: "scan", step: "Scan", title: "Watch the scan run" },
  { id: "rank", step: "Rank", title: "Read the ranking" },
  { id: "export", step: "Export", title: "Export to your tracker" },
  { id: "try", step: "Try it", title: "Run one free" },
];

export function markOnboardingSeen(): void {
  try {
    localStorage.setItem(ONBOARDING_DISMISSED_KEY, "1");
  } catch {
    // Private browsing rejects writes. Showing the walkthrough again next visit
    // is a far smaller problem than throwing here.
  }
}

/**
 * Whether to greet this visitor. The *old* export-preview opt-out counts too: a
 * returning customer who already ticked "don't show this again" should not be
 * handed a new modal just because we rewrote it.
 */
export function shouldShowOnboarding(): boolean {
  try {
    return (
      !localStorage.getItem(ONBOARDING_DISMISSED_KEY) &&
      !localStorage.getItem(PREVIEW_DISMISSED_KEY)
    );
  } catch {
    return false;
  }
}

export default function OnboardingCarousel({
  samples,
  onClose,
  onRunSample,
  onUseAddress,
}: OnboardingCarouselProps) {
  const [index, setIndex] = useState(0);
  const [direction, setDirection] = useState<"next" | "prev">("next");
  // Auto-advance is a one-way switch. Nothing is worse than a carousel that
  // yanks itself away while someone is reading, so any deliberate interaction
  // ends it permanently rather than pausing it.
  const [interacted, setInteracted] = useState(false);
  const [preview, setPreview] = useState<PreviewData | null>(null);
  const [typed, setTyped] = useState("");
  // Unchecked by default: closing the walkthrough no longer decides for the
  // visitor that they never want to see it again. Ticking the box is the only
  // thing that suppresses it, and it then never returns.
  const [remember, setRemember] = useState(false);

  const reducedMotion = useReducedMotion();
  const dialogRef = useRef<HTMLDivElement>(null);
  useFocusTrap(dialogRef);

  const sample = samples[0] ?? null;

  const dismiss = useCallback(() => {
    if (remember) markOnboardingSeen();
    onClose();
  }, [onClose, remember]);

  // `next` is deliberately un-wrapped when the direction is decided, so a wrap
  // from the last panel to the first still animates forward.
  const goTo = useCallback(
    (next: number, manual: boolean) => {
      if (manual) setInteracted(true);
      setDirection(next > index ? "next" : "prev");
      setIndex((next + PANELS.length) % PANELS.length);
    },
    [index]
  );

  // Real data for the middle panels. One request, cached upstream for ten
  // minutes and served entirely from our own database — no paid API is touched.
  useEffect(() => {
    if (!sample || preview) return;
    let cancelled = false;
    const qs = new URLSearchParams({ chain: sample.chain, address: sample.address });
    fetch(`/api/preview?${qs}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (cancelled || !data?.token || !Array.isArray(data.traders)) return;
        setPreview({ token: data.token, traders: data.traders });
      })
      .catch(() => {
        // Panels fall back to showing no figures. Never to invented ones.
      });
    return () => {
      cancelled = true;
    };
  }, [sample, preview]);

  // Auto-advance, until the first interaction — and never at all for a visitor
  // who asked for reduced motion.
  useEffect(() => {
    if (interacted || reducedMotion) return;
    // Stops on the last panel rather than looping: that one has something to do
    // on it, and cycling back to step 1 under someone's cursor is the same
    // rudeness as advancing mid-read.
    if (index >= PANELS.length - 1) return;
    const timer = setTimeout(() => {
      setDirection("next");
      setIndex(index + 1);
    }, AUTO_ADVANCE_MS);
    return () => clearTimeout(timer);
  }, [index, interacted, reducedMotion]);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        dismiss();
      } else if (event.key === "ArrowRight") {
        goTo(index + 1, true);
      } else if (event.key === "ArrowLeft") {
        goTo(index - 1, true);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dismiss, goTo, index]);

  const touchStartX = useRef<number | null>(null);
  function onTouchStart(event: React.TouchEvent) {
    touchStartX.current = event.touches[0]?.clientX ?? null;
  }
  function onTouchEnd(event: React.TouchEvent) {
    const start = touchStartX.current;
    touchStartX.current = null;
    if (start === null) return;
    const delta = (event.changedTouches[0]?.clientX ?? start) - start;
    if (Math.abs(delta) < SWIPE_THRESHOLD_PX) return;
    goTo(index + (delta < 0 ? 1 : -1), true);
  }

  const panel = PANELS[index];
  const animation = reducedMotion
    ? ""
    : direction === "next"
    ? "animate-panel-right"
    : "animate-panel-left";

  return (
    <div
      className="fixed inset-0 z-[70] flex items-end justify-center bg-black/85 p-0 backdrop-blur-md sm:items-center sm:p-4"
      onClick={dismiss}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="How Alpha Wallet Finder works"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        onTouchStart={onTouchStart}
        onTouchEnd={onTouchEnd}
        // Fixed height, not content height: the five panels are not the same
        // size, and letting the dialog resize under an auto-advance threw the
        // whole thing around the screen between steps. Taller panels scroll
        // inside the body instead.
        className="flex h-[88vh] w-full max-w-3xl flex-col overflow-hidden rounded-t-2xl border border-neutral-800 bg-neutral-950 shadow-2xl shadow-black/60 outline-none sm:h-[min(34rem,90vh)] sm:rounded-2xl"
      >
        {/* Header: step rail doubles as the dot indicator on wide screens. */}
        <div className="flex items-start justify-between gap-4 border-b border-neutral-800/80 bg-gradient-to-b from-neutral-900/80 to-neutral-950 px-5 py-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="rounded-md bg-blue-500/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-blue-300">
                Step {index + 1}/{PANELS.length}
              </span>
              <span className="truncate text-[11px] text-neutral-500">{panel.step}</span>
            </div>
            <h2 className="mt-1.5 text-[15px] font-semibold tracking-tight text-neutral-50">
              {panel.title}
            </h2>
          </div>
          <button
            onClick={dismiss}
            aria-label="Close walkthrough"
            className="-mr-1 -mt-1 shrink-0 rounded-lg p-2 text-neutral-500 transition-colors hover:bg-neutral-800 hover:text-neutral-100"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Panel body. `key` on the panel id restarts the entry animation and,
            more importantly, resets any per-panel state (the staged reveal). */}
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5">
          <div key={panel.id} className={animation}>
            {panel.id === "paste" && <PastePanel sample={sample} />}
            {panel.id === "scan" && (
              <ScanPanel preview={preview} sample={sample} reducedMotion={reducedMotion} />
            )}
            {panel.id === "rank" && <RankPanel preview={preview} />}
            {panel.id === "export" && <ExportPanel preview={preview} />}
            {panel.id === "try" && (
              <TryPanel
                sample={sample}
                typed={typed}
                onTyped={(value) => {
                  setInteracted(true);
                  setTyped(value);
                }}
                onRunSample={() => {
                  if (remember) markOnboardingSeen();
                  if (sample) onRunSample(sample);
                }}
                onUseAddress={() => {
                  if (remember) markOnboardingSeen();
                  onUseAddress(typed.trim());
                }}
              />
            )}
          </div>
        </div>

        {/* Controls */}
        <div className="border-t border-neutral-800/80 bg-neutral-950 px-5 py-3">
          <div className="flex items-center gap-3">
            <button
              onClick={() => goTo(index - 1, true)}
              disabled={index === 0}
              aria-label="Previous step"
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-neutral-800 text-neutral-400 transition-colors hover:border-neutral-700 hover:text-neutral-100 disabled:opacity-30 disabled:hover:border-neutral-800"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <path d="m14 18-6-6 6-6" />
              </svg>
            </button>

            <div className="flex flex-1 items-center justify-center gap-2">
              {PANELS.map((p, i) => (
                <button
                  key={p.id}
                  onClick={() => goTo(i, true)}
                  aria-label={`Go to step ${i + 1}: ${p.step}`}
                  aria-current={i === index ? "step" : undefined}
                  className={`h-1.5 rounded-full transition-all duration-200 ${
                    i === index
                      ? "w-6 bg-blue-400"
                      : "w-1.5 bg-neutral-700 hover:bg-neutral-500"
                  }`}
                />
              ))}
            </div>

            {index === PANELS.length - 1 ? (
              <button
                onClick={dismiss}
                className="shrink-0 rounded-lg border border-neutral-800 px-4 py-2 text-xs font-medium text-neutral-300 transition-colors hover:border-neutral-700 hover:text-neutral-100"
              >
                Done
              </button>
            ) : (
              <button
                onClick={() => goTo(index + 1, true)}
                aria-label="Next step"
                className="flex shrink-0 items-center gap-1.5 rounded-lg bg-gradient-to-b from-blue-500 to-blue-600 px-4 py-2 text-xs font-semibold text-white shadow shadow-blue-600/20 transition-all hover:from-blue-400 hover:to-blue-500"
              >
                Next
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                  <path d="m10 6 6 6-6 6" />
                </svg>
              </button>
            )}
          </div>

          <label className="mt-2 flex cursor-pointer items-center justify-center gap-2 text-[11px] text-neutral-500 hover:text-neutral-300">
            <input
              type="checkbox"
              checked={remember}
              onChange={(e) => setRemember(e.target.checked)}
              className="h-3 w-3 accent-blue-500"
            />
            Don&apos;t show this again
          </label>
        </div>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Panels                                                                     */
/* -------------------------------------------------------------------------- */

function PanelCopy({ children }: { children: React.ReactNode }) {
  return <p className="mb-4 text-sm leading-relaxed text-neutral-400">{children}</p>;
}

/**
 * Shows the real search bar, pre-filled with a real contract address. Built from
 * the same markup as the live one so nothing on the actual page is a surprise.
 */
function PastePanel({ sample }: { sample: OnboardingSample | null }) {
  const CHAINS: Array<{ value: Chain; short: string; dot: string }> = [
    { value: "solana", short: "SOL", dot: "bg-violet-400" },
    { value: "bsc", short: "BNB", dot: "bg-yellow-400" },
    { value: "base", short: "BASE", dot: "bg-blue-400" },
    { value: "robinhood", short: "HOOD", dot: "bg-emerald-400" },
  ];
  const active = sample?.chain ?? "solana";

  return (
    <div>
      <PanelCopy>
        Paste a token contract address and pick the chain. An invalid address is
        rejected before it costs a scan.
      </PanelCopy>

      <div className="flex flex-col gap-3 rounded-2xl border border-neutral-800 bg-neutral-900/60 p-3 sm:flex-row sm:items-center">
        <div className="flex shrink-0 overflow-hidden rounded-xl border border-neutral-800 bg-neutral-950">
          {CHAINS.map((c) => (
            <span
              key={c.value}
              className={`flex items-center justify-center gap-1.5 px-3 py-2.5 text-sm font-medium ${
                c.value === active ? "bg-blue-500/20 text-blue-200" : "text-neutral-600"
              }`}
            >
              <span className={`h-1.5 w-1.5 rounded-full ${c.dot}`} />
              {c.short}
            </span>
          ))}
        </div>
        <div className="min-w-0 flex-1 truncate rounded-xl border border-blue-500/50 bg-neutral-950 px-3 py-2.5 font-mono text-xs text-neutral-200 ring-2 ring-blue-500/20">
          {sample ? sample.address : "Paste token contract address (CA)…"}
          {!sample && <span className="ml-0.5 inline-block h-3.5 w-px bg-blue-400 align-middle" />}
        </div>
        <span className="shrink-0 rounded-xl bg-gradient-to-b from-blue-500 to-blue-600 px-5 py-2.5 text-center text-sm font-semibold text-white">
          Find Wallets
        </span>
      </div>

      {sample && (
        <p className="mt-3 text-[11px] text-neutral-500">
          Live contract for{" "}
          <span className="font-medium text-neutral-300">${sample.symbol}</span>, used on every
          panel below.
        </p>
      )}
    </div>
  );
}

/**
 * A replay of a stored scan, revealed at the pace a real one arrives. The rows,
 * the count and the token are all real; only the timing is a replay, which the
 * caption says outright.
 */
function ScanPanel({
  preview,
  sample,
  reducedMotion,
}: {
  preview: PreviewData | null;
  sample: OnboardingSample | null;
  reducedMotion: boolean;
}) {
  const total = preview?.traders.length ?? 0;
  // Counts arrived pages, not rows: that is what the NDJSON progress events
  // actually look like — a figure jumping by a page at a time as each lands.
  const [pages, setPages] = useState(0);

  useEffect(() => {
    if (total === 0 || reducedMotion) return;
    let n = 0;
    const timer = setInterval(() => {
      n += 1;
      setPages(n);
      if (n >= REVEAL_PAGES) clearInterval(timer);
    }, 260);
    return () => clearInterval(timer);
  }, [total, reducedMotion]);

  // Derived rather than stored, so nothing has to be reset: this panel is
  // remounted (keyed on the panel id) every time it becomes visible.
  const found = reducedMotion
    ? total
    : Math.min(total, Math.round((pages / REVEAL_PAGES) * total));
  const shown = preview?.traders.slice(0, Math.min(found, PANEL_ROWS)) ?? [];

  return (
    <div>
      <PanelCopy>
        Wallets arrive in pages with a live count. A Top 500 takes a few seconds.
      </PanelCopy>

      <div className="relative overflow-hidden rounded-2xl border border-neutral-800 bg-neutral-900/40">
        <div className="absolute -right-16 -top-16 opacity-70">
          <RadarSweep size={200} />
        </div>

        <div className="relative px-5 py-5">
          <div className="flex items-baseline gap-2">
            <span className="tnum text-3xl font-semibold text-neutral-50">{found}</span>
            <span className="text-sm text-neutral-500">
              of <span className="tnum">{total || "—"}</span> wallets
            </span>
          </div>
          <div className="mt-3 h-1 w-full overflow-hidden rounded-full bg-neutral-800">
            <div
              className="h-full rounded-full bg-gradient-to-r from-blue-500 to-blue-400 transition-[width] duration-200 ease-out"
              style={{ width: total > 0 ? `${(found / total) * 100}%` : "0%" }}
            />
          </div>

          <div className="mt-4 space-y-1.5">
            {shown.map((t) => (
              <div
                key={t.address}
                className="animate-row-land flex items-center gap-3 rounded-lg border border-neutral-800/70 bg-neutral-950/60 px-3 py-2"
              >
                <span className="tnum w-5 text-[11px] text-neutral-600">#{t.rank}</span>
                <span className="font-mono text-xs text-neutral-300">
                  {shortenAddress(t.address, 4)}
                </span>
                <span className="tnum ml-auto text-xs font-medium text-blue-300">
                  {t.avgMultipleX === null ? "n/a" : formatMultiple(t.avgMultipleX)}
                </span>
                <span className="tnum w-20 text-right text-xs font-semibold text-emerald-400">
                  {formatUsd(t.realizedPnlUsd)}
                </span>
              </div>
            ))}
            {shown.length === 0 && (
              <p className="py-6 text-center text-xs text-neutral-600">
                {total === 0 ? "Loading a real scan…" : "Paging the chain…"}
              </p>
            )}
          </div>
        </div>
      </div>

      {sample && (
        <p className="mt-3 text-[11px] text-neutral-500">
          Real ${sample.symbol} results, replayed from our database. The figures are unchanged. Only
          the pacing is simulated.
        </p>
      )}
    </div>
  );
}

/** The ranking, in the same visual language as the live results table. */
function RankPanel({ preview }: { preview: PreviewData | null }) {
  // Total PNL, ordered and numbered exactly as the real table does it: the
  // stored scan arrives in the provider's realized-PNL order, which would show
  // a #3 at the top of a list sorted any other way.
  const rows = useMemo(() => {
    const all = (preview?.traders ?? []).map((t) => ({
      trader: t,
      pnlUsd: t.realizedPnlUsd + (t.unrealizedPnlUsd ?? 0),
    }));
    return all.sort((a, b) => b.pnlUsd - a.pnlUsd).slice(0, PANEL_ROWS);
  }, [preview]);

  return (
    <div>
      <PanelCopy>
        Ranked by total PNL: profit taken plus the value of tokens still held.
        Each row shows the multiple, average entry and exit, and the size left.
      </PanelCopy>

      <div className="overflow-hidden rounded-2xl border border-neutral-800 bg-neutral-900/40">
        <div className="grid grid-cols-[2rem_1fr_4rem_5.5rem] gap-2 border-b border-neutral-800 px-4 py-2 text-[10px] font-medium uppercase tracking-wider text-neutral-500 sm:grid-cols-[1.75rem_1fr_4rem_5.5rem_9rem]">
          <span>#</span>
          <span>Wallet</span>
          <span className="text-right">Avg X</span>
          <span className="text-right">$ PNL</span>
          <span className="hidden text-right sm:block">Entry → Exit</span>
        </div>
        {rows.length === 0 ? (
          <p className="px-4 py-10 text-center text-xs text-neutral-600">
            Loading a real scan…
          </p>
        ) : (
          rows.map(({ trader: t, pnlUsd }, i) => (
            <div
              key={t.address}
              className={`grid grid-cols-[2rem_1fr_4rem_5.5rem] items-center gap-2 border-b border-neutral-900/70 px-4 py-2.5 text-xs sm:grid-cols-[1.75rem_1fr_4rem_5.5rem_9rem] ${
                i === 0 ? "bg-amber-500/[0.04]" : ""
              }`}
            >
              <span
                className={`tnum ${i < 3 ? "font-bold text-amber-300" : "text-neutral-500"}`}
              >
                {i + 1}
              </span>
              <span className="truncate font-mono text-neutral-200">
                {shortenAddress(t.address, 5)}
              </span>
              <span className="tnum text-right font-medium text-blue-300">
                {t.avgMultipleX === null ? "n/a" : formatMultiple(t.avgMultipleX)}
              </span>
              <span
                className={`tnum text-right font-semibold ${
                  pnlUsd >= 0 ? "text-emerald-400" : "text-rose-400"
                }`}
              >
                {formatUsd(pnlUsd)}
              </span>
              {/* nowrap: two six-figure mcaps used to wrap onto a second line
                  and knock this row out of alignment with the others. */}
              <span className="tnum hidden whitespace-nowrap text-right text-[11px] text-neutral-400 sm:block">
                {formatUsd(t.avgBuyMcapUsd)} → {formatUsd(t.avgSellMcapUsd)}
              </span>
            </div>
          ))
        )}
      </div>

      <p className="mt-3 text-[11px] text-neutral-500">
        Sort and filter by multiple, PNL, entry or size bought. Or show only wallets already caught
        winning on other tokens.
      </p>
    </div>
  );
}

/** The literal bytes the export button downloads, built by the real exporter. */
function ExportPanel({ preview }: { preview: PreviewData | null }) {
  const rows = useMemo(() => preview?.traders.slice(0, 3) ?? [], [preview]);
  const symbol = preview?.token.symbol ?? "TOKEN";

  const json = useMemo(
    () =>
      rows.length === 0
        ? null
        : JSON.stringify(buildExportEntries(symbol, rows, DEFAULT_EXPORT_OPTIONS), null, 2),
    [rows, symbol]
  );

  return (
    <div>
      <PanelCopy>
        Select the wallets you want and export. The file below is the real
        output, byte for byte.
      </PanelCopy>

      <div className="overflow-hidden rounded-2xl border border-neutral-800 bg-neutral-950">
        <div className="flex items-center justify-between border-b border-neutral-800 px-4 py-2.5">
          <span className="truncate font-mono text-[11px] text-neutral-400">
            highpnl {symbol.toLowerCase()}.json
          </span>
          <span className="shrink-0 rounded-md bg-neutral-800 px-1.5 py-0.5 text-[10px] text-neutral-400">
            real output
          </span>
        </div>
        <pre className="max-h-64 overflow-auto px-4 py-3 text-[11px] leading-relaxed text-neutral-400">
          <code>{json ?? "// loading a real scan…"}</code>
        </pre>
      </div>

      <p className="mt-3 text-[11px] text-neutral-500">
        <span className="font-medium text-neutral-300">Copy JSON</span> pastes straight into your
        tracker, with no download step.
      </p>
    </div>
  );
}

/** The point of the whole walkthrough: run a real scan before paying for one. */
function TryPanel({
  sample,
  typed,
  onTyped,
  onRunSample,
  onUseAddress,
}: {
  sample: OnboardingSample | null;
  typed: string;
  onTyped: (value: string) => void;
  onRunSample: () => void;
  onUseAddress: () => void;
}) {
  return (
    <div>
      <PanelCopy>
        Run a free sample scan, or scan a token of your own.
      </PanelCopy>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="flex flex-col rounded-2xl border border-emerald-900/50 bg-emerald-950/15 p-4">
          <span className="w-fit rounded-md bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-emerald-400">
            Free
          </span>
          <h3 className="mt-2.5 text-sm font-semibold text-neutral-100">
            {sample ? `Replay the $${sample.symbol} scan` : "Replay a sample scan"}
          </h3>
          <p className="mt-1 flex-1 text-[11px] leading-relaxed text-neutral-400">
            {sample
              ? `${sample.walletCount} ranked wallets from our database. Free, and no wallet needed.`
              : "A real ranking from our database. Free, and no wallet needed."}
          </p>
          <button
            onClick={onRunSample}
            disabled={!sample}
            className="mt-3 rounded-xl bg-emerald-600 px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Show me the wallets
          </button>
        </div>

        <div className="flex flex-col rounded-2xl border border-neutral-800 bg-neutral-900/40 p-4">
          <span className="w-fit rounded-md bg-neutral-800 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-neutral-400">
            Your token
          </span>
          <h3 className="mt-2.5 text-sm font-semibold text-neutral-100">Scan a specific coin</h3>
          <p className="mt-1 text-[11px] leading-relaxed text-neutral-400">
            Paste the contract address to load it into the search bar.
          </p>
          <input
            value={typed}
            onChange={(e) => onTyped(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && typed.trim()) onUseAddress();
            }}
            placeholder="Contract address…"
            spellCheck={false}
            aria-label="Token contract address"
            className="mt-2.5 w-full min-w-0 rounded-xl border border-neutral-800 bg-neutral-950 px-3 py-2.5 font-mono text-xs text-neutral-100 outline-none transition-colors placeholder:font-sans focus:border-blue-500/60 focus:ring-2 focus:ring-blue-500/20"
          />
          <button
            onClick={onUseAddress}
            disabled={!typed.trim()}
            className="mt-2.5 rounded-xl border border-neutral-700 px-4 py-2.5 text-sm font-semibold text-neutral-100 transition-colors hover:border-neutral-600 hover:bg-neutral-800 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Load it in
          </button>
        </div>
      </div>

      <p className="mt-3 text-[11px] leading-relaxed text-neutral-500">
        Nothing here charges you. Pricing appears only when you scan a token of your own.
      </p>
    </div>
  );
}
