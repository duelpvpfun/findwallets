"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useAccount } from "./AccountProvider";

/**
 * Header control: "Connect" when signed out, a truncated address with a dropdown
 * when signed in.
 *
 * The copy is deliberate. People have been trained that connecting a wallet is
 * the prelude to signing a transaction, so the button says what it costs before
 * the wallet prompt appears rather than after.
 */
export default function WalletConnectButton() {
  const { user, balance, loading, busy, error, signIn, signOut, clearError } = useAccount();
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: MouseEvent | TouchEvent) {
      if (!menuRef.current?.contains(event.target as Node)) setOpen(false);
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // Nothing rendered until the session is known, so the button never flickers
  // from "Connect" to an address on every page load.
  if (loading) {
    return <span className="h-[30px] w-[104px] animate-pulse rounded-md bg-neutral-900" />;
  }

  if (!user) {
    return (
      <div className="relative">
        <button
          onClick={() => void signIn()}
          disabled={busy}
          title="Free — signs a message, never a transaction"
          className="flex items-center gap-1.5 rounded-md border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-xs font-semibold text-neutral-100 transition-colors hover:border-neutral-600 hover:bg-neutral-800 disabled:opacity-60"
        >
          <WalletIcon />
          {busy ? "Check your wallet…" : "Connect"}
        </button>
        {error && (
          <div className="absolute right-0 top-full z-50 mt-2 w-64 rounded-lg border border-amber-900/60 bg-neutral-950 p-3 text-[11px] leading-relaxed text-amber-300 shadow-xl">
            {error}
            <button
              onClick={clearError}
              className="mt-2 block text-neutral-500 underline underline-offset-2 hover:text-neutral-300"
            >
              Dismiss
            </button>
          </div>
        )}
      </div>
    );
  }

  const short = `${user.wallet.slice(0, 4)}…${user.wallet.slice(-4)}`;
  const total = balance?.total ?? 0;

  return (
    <div className="relative" ref={menuRef}>
      <button
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="menu"
        className="flex items-center gap-2 rounded-md border border-neutral-800 bg-neutral-900 px-2.5 py-1.5 text-xs font-medium text-neutral-200 transition-colors hover:border-neutral-700"
      >
        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-400" />
        <span className="font-mono">{short}</span>
        {total > 0 && (
          <span className="tnum rounded bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-300">
            {total}
          </span>
        )}
        <svg
          width="11"
          height="11"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          className={`text-neutral-500 transition-transform duration-150 ${open ? "rotate-180" : ""}`}
        >
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>

      {open && (
        <div
          role="menu"
          className="animate-fade-in absolute right-0 top-full z-50 mt-2 w-60 overflow-hidden rounded-xl border border-neutral-800 bg-neutral-950 shadow-2xl shadow-black/50"
        >
          <div className="border-b border-neutral-800/80 px-3.5 py-3">
            <div className="text-[10px] uppercase tracking-wider text-neutral-500">Wallet</div>
            <div className="mt-0.5 truncate font-mono text-[11px] text-neutral-300">
              {user.wallet}
            </div>
          </div>

          <div className="border-b border-neutral-800/80 px-3.5 py-3">
            <div className="flex items-baseline justify-between">
              <span className="text-[11px] text-neutral-400">Scans available</span>
              <span className="tnum text-sm font-semibold text-neutral-100">{total}</span>
            </div>
            {balance && balance.byTier.length > 0 && (
              <div className="mt-1.5 flex flex-wrap gap-1">
                {balance.byTier.map((t) => (
                  <span
                    key={t.tier}
                    className="tnum rounded bg-neutral-800 px-1.5 py-0.5 text-[10px] text-neutral-300"
                  >
                    {t.count}× Top {t.tier}
                  </span>
                ))}
              </div>
            )}
            {balance && balance.pending > 0 && (
              <p className="tnum mt-1.5 text-[10px] text-amber-400/90">
                {balance.pending} held by a scan in flight
              </p>
            )}
          </div>

          <Link
            href="/profile"
            onClick={() => setOpen(false)}
            className="block px-3.5 py-2.5 text-xs font-medium text-neutral-200 transition-colors hover:bg-neutral-900"
          >
            Purchases &amp; saved results
          </Link>
          <button
            onClick={() => {
              setOpen(false);
              void signOut();
            }}
            className="block w-full px-3.5 py-2.5 text-left text-xs text-neutral-400 transition-colors hover:bg-neutral-900 hover:text-neutral-200"
          >
            Disconnect
          </button>
        </div>
      )}
    </div>
  );
}

function WalletIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 8a2 2 0 0 1 2-2h13a1 1 0 0 1 1 1v2" />
      <path d="M3 8v9a2 2 0 0 0 2 2h14a1 1 0 0 0 1-1v-2" />
      <path d="M16 12h5v4h-5a2 2 0 0 1 0-4Z" />
    </svg>
  );
}
