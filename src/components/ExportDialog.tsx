"use client";

import { useEffect, useMemo, useState } from "react";
import type { WalletTrader } from "@/lib/types";
import {
  buildExportEntries,
  buildExportJson,
  copyText,
  DEFAULT_EXPORT_OPTIONS,
  exportTraders,
  type ExportOptions,
  type NameStyle,
} from "@/lib/export";
import { tokenNameForExport } from "@/lib/format";

const EMOJI_CHOICES = ["", "🧓", "👻", "🐍", "🦅", "🧙", "🐉", "🥷", "🦈", "🐺", "🦊", "🐯", "🦁", "💎", "🚀", "🐳"];

const NAME_STYLES: Array<{ value: NameStyle; label: string; example: string }> = [
  { value: "multiple", label: "Multiple", example: "25.00x - MOONCAT" },
  { value: "pnl", label: "$ PNL", example: "$1.2M - MOONCAT" },
  { value: "rank", label: "Rank", example: "#1 - MOONCAT" },
  { value: "address", label: "Address", example: "C5tT...msxu" },
];

interface ExportDialogProps {
  tokenName: string;
  tokenSymbol: string;
  traders: WalletTrader[];
  onClose: () => void;
}

export default function ExportDialog({ tokenName, tokenSymbol, traders, onClose }: ExportDialogProps) {
  const [opts, setOpts] = useState<ExportOptions>({
    ...DEFAULT_EXPORT_OPTIONS,
    filename: tokenNameForExport(tokenName),
  });
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  function set<K extends keyof ExportOptions>(key: K, value: ExportOptions[K]) {
    setOpts((prev) => ({ ...prev, [key]: value }));
  }

  const preview = useMemo(
    () => buildExportEntries(tokenSymbol, traders.slice(0, 2), opts),
    [tokenSymbol, traders, opts]
  );

  function handleExport() {
    exportTraders(tokenName, tokenSymbol, traders, opts);
    onClose();
  }

  async function handleCopy() {
    const ok = await copyText(buildExportJson(tokenSymbol, traders, opts));
    setCopyState(ok ? "copied" : "failed");
    setTimeout(() => setCopyState("idle"), 2000);
  }

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm animate-fade-in"
      onClick={onClose}
    >
      <div
        className="flex max-h-[90vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-neutral-800 bg-neutral-950 shadow-2xl shadow-black/50"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-neutral-800 bg-gradient-to-b from-neutral-900/60 to-transparent px-5 py-4">
          <div>
            <h3 className="text-sm font-semibold text-neutral-50">Export {traders.length} wallets</h3>
            <p className="text-[11px] text-neutral-500">Customize how they appear in your tracking bot</p>
          </div>
          <button
            onClick={onClose}
            className="rounded-lg p-1.5 text-neutral-400 transition-colors hover:bg-neutral-800 hover:text-neutral-200"
            aria-label="Close"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="space-y-5 overflow-y-auto px-5 py-5">
          {/* Naming */}
          <section>
            <SectionTitle>Wallet name</SectionTitle>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {NAME_STYLES.map((s) => (
                <button
                  key={s.value}
                  onClick={() => set("nameStyle", s.value)}
                  className={`rounded-lg border px-2.5 py-2 text-left transition-colors ${
                    opts.nameStyle === s.value
                      ? "border-blue-500/60 bg-blue-500/10"
                      : "border-neutral-800 bg-neutral-900 hover:border-neutral-700"
                  }`}
                >
                  <div className="text-xs font-medium text-neutral-200">{s.label}</div>
                  <div className="mt-0.5 truncate font-mono text-[10px] text-neutral-500">{s.example}</div>
                </button>
              ))}
            </div>
            <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label="Name prefix (optional)">
                <input
                  value={opts.namePrefix}
                  onChange={(e) => set("namePrefix", e.target.value)}
                  placeholder="e.g. alpha "
                  className="w-full rounded-lg border border-neutral-800 bg-neutral-900 px-2.5 py-1.5 text-xs text-neutral-100 outline-none focus:border-blue-500/60"
                />
              </Field>
              <Field label="Group">
                <input
                  value={opts.group}
                  onChange={(e) => set("group", e.target.value)}
                  placeholder="Main"
                  className="w-full rounded-lg border border-neutral-800 bg-neutral-900 px-2.5 py-1.5 text-xs text-neutral-100 outline-none focus:border-blue-500/60"
                />
              </Field>
            </div>
            <label className="mt-2.5 flex items-center gap-2 text-xs text-neutral-400">
              <input
                type="checkbox"
                checked={opts.preferNickname}
                onChange={(e) => set("preferNickname", e.target.checked)}
                className="h-3.5 w-3.5 accent-blue-500"
              />
              Use known KOL / nickname when available
            </label>
          </section>

          {/* Emoji */}
          <section>
            <SectionTitle>Emoji</SectionTitle>
            <div className="flex flex-wrap gap-1.5">
              {EMOJI_CHOICES.map((e) => (
                <button
                  key={e || "auto"}
                  onClick={() => set("emoji", e)}
                  title={e ? e : "Auto (varies per wallet)"}
                  className={`flex h-9 min-w-9 items-center justify-center rounded-lg border px-2 text-base transition-colors ${
                    opts.emoji === e
                      ? "border-blue-500/60 bg-blue-500/10"
                      : "border-neutral-800 bg-neutral-900 hover:border-neutral-700"
                  }`}
                >
                  {e || <span className="text-[10px] font-medium text-neutral-400">Auto</span>}
                </button>
              ))}
            </div>
          </section>

          {/* Alerts */}
          <section>
            <SectionTitle>Alerts</SectionTitle>
            <div className="space-y-1.5">
              <Toggle
                label="Toast alerts"
                checked={opts.alertsOnToast}
                onChange={(v) => set("alertsOnToast", v)}
              />
              <Toggle
                label="Bubble alerts"
                checked={opts.alertsOnBubble}
                onChange={(v) => set("alertsOnBubble", v)}
              />
              <Toggle label="Feed alerts" checked={opts.alertsOnFeed} onChange={(v) => set("alertsOnFeed", v)} />
            </div>
            <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label="Sound">
                <input
                  value={opts.sound}
                  onChange={(e) => set("sound", e.target.value)}
                  placeholder="default"
                  className="w-full rounded-lg border border-neutral-800 bg-neutral-900 px-2.5 py-1.5 text-xs text-neutral-100 outline-none focus:border-blue-500/60"
                />
              </Field>
              <Field label="Filename">
                <input
                  value={opts.filename}
                  onChange={(e) => set("filename", e.target.value)}
                  className="w-full rounded-lg border border-neutral-800 bg-neutral-900 px-2.5 py-1.5 text-xs text-neutral-100 outline-none focus:border-blue-500/60"
                />
              </Field>
            </div>
          </section>

          {/* Live preview */}
          <section>
            <SectionTitle>Preview</SectionTitle>
            <pre className="max-h-48 overflow-auto rounded-lg border border-neutral-800 bg-neutral-900/60 p-3 font-mono text-[10px] leading-relaxed text-neutral-400">
              {JSON.stringify(preview, null, 2)}
            </pre>
          </section>
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-neutral-800 bg-neutral-950 px-5 py-3">
          <button
            onClick={() => setOpts({ ...DEFAULT_EXPORT_OPTIONS, filename: tokenNameForExport(tokenName) })}
            className="text-xs text-neutral-500 underline hover:text-neutral-300"
          >
            Reset to defaults
          </button>
          <div className="flex gap-2">
            <button
              onClick={handleCopy}
              className={`rounded-lg border px-3 py-2 text-xs font-medium transition-colors ${
                copyState === "copied"
                  ? "border-emerald-700/60 bg-emerald-950/40 text-emerald-300"
                  : copyState === "failed"
                  ? "border-rose-800/60 bg-rose-950/40 text-rose-300"
                  : "border-neutral-800 bg-neutral-900 text-neutral-300 hover:border-neutral-700"
              }`}
            >
              {copyState === "copied"
                ? "Copied!"
                : copyState === "failed"
                ? "Copy failed"
                : "Copy JSON"}
            </button>
            <button
              onClick={handleExport}
              className="rounded-lg bg-gradient-to-b from-blue-500 to-blue-600 px-4 py-2 text-xs font-semibold text-white shadow shadow-blue-600/20 hover:from-blue-400 hover:to-blue-500"
            >
              Download {traders.length} wallets
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <div className="mb-2 text-xs font-medium uppercase tracking-wide text-neutral-500">{children}</div>;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11px] text-neutral-500">{label}</span>
      {children}
    </label>
  );
}

function Toggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-center justify-between rounded-lg border border-neutral-800 bg-neutral-900 px-3 py-2">
      <span className="text-xs text-neutral-300">{label}</span>
      <button
        type="button"
        onClick={() => onChange(!checked)}
        className={`relative h-5 w-9 rounded-full transition-colors ${checked ? "bg-blue-500" : "bg-neutral-700"}`}
        aria-pressed={checked}
      >
        <span
          className={`absolute top-0.5 left-0.5 h-4 w-4 rounded-full bg-white transition-transform ${
            checked ? "translate-x-4" : "translate-x-0"
          }`}
        />
      </button>
    </label>
  );
}
