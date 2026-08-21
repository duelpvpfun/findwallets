"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { CLAIM_STORAGE_KEY } from "@/lib/tiers";

type Status =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "recovered"; tier: number };

export default function RecoverPage() {
  const router = useRouter();
  const [signature, setSignature] = useState("");
  const [status, setStatus] = useState<Status>({ kind: "idle" });

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const value = signature.trim();
    if (!value) return;

    setStatus({ kind: "loading" });
    try {
      const res = await fetch(`/api/pay/recover?signature=${encodeURIComponent(value)}`);
      const data = await res.json();
      if (!res.ok || data.error) {
        setStatus({ kind: "error", message: data.error ?? "Could not recover that purchase." });
        return;
      }
      // Stored under the same key the scan flow reads, so the buyer lands back
      // on the search screen with their credit already loaded.
      localStorage.setItem(
        CLAIM_STORAGE_KEY,
        JSON.stringify({ token: data.claimToken, tier: data.tier })
      );
      setStatus({ kind: "recovered", tier: data.tier });
    } catch {
      setStatus({ kind: "error", message: "Failed to reach the server." });
    }
  }

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-neutral-950 px-4 text-neutral-100">
      <div className="w-full max-w-md">
        <Link href="/" className="flex items-center justify-center gap-3">
          <span className="alpha-glow select-none text-3xl leading-none font-semibold text-white">
            α
          </span>
        </Link>
        <h1 className="mt-6 text-center text-lg font-semibold">Recover a purchase</h1>
        <p className="mt-2 text-center text-sm text-neutral-400">
          Paste the Solana transaction signature from your payment. If the scan it paid for was
          never delivered, you&apos;ll get your credit back.
        </p>

        <form onSubmit={handleSubmit} className="mt-6 flex flex-col gap-3">
          <input
            value={signature}
            onChange={(e) => setSignature(e.target.value)}
            placeholder="Transaction signature…"
            spellCheck={false}
            className="w-full truncate rounded-xl border border-neutral-800 bg-neutral-900 px-4 py-3 font-mono text-sm text-neutral-100 outline-none transition-colors placeholder:font-sans placeholder:text-neutral-600 focus:border-blue-500/60 focus:ring-2 focus:ring-blue-500/20"
          />
          <button
            type="submit"
            disabled={status.kind === "loading" || !signature.trim()}
            className="rounded-xl bg-gradient-to-b from-blue-500 to-blue-600 px-5 py-3 text-sm font-semibold text-white shadow-lg shadow-blue-600/25 transition-all hover:from-blue-400 hover:to-blue-500 disabled:cursor-not-allowed disabled:opacity-50 disabled:shadow-none"
          >
            {status.kind === "loading" ? "Checking…" : "Recover my credit"}
          </button>
        </form>

        {status.kind === "error" && (
          <p className="mt-4 rounded-xl border border-rose-900/60 bg-rose-950/30 px-4 py-3 text-sm text-rose-300">
            {status.message}
          </p>
        )}

        {status.kind === "recovered" && (
          <div className="mt-4 rounded-xl border border-emerald-900/60 bg-emerald-950/30 px-4 py-3 text-sm text-emerald-300">
            Credit restored. Top {status.tier} is loaded in this browser.
            <button
              onClick={() => router.push("/")}
              className="mt-2 block font-medium underline underline-offset-2 hover:text-emerald-200"
            >
              Run your scan →
            </button>
          </div>
        )}

        <p className="mt-6 text-center text-xs text-neutral-600">
          Still stuck?{" "}
          <a
            href="https://x.com/crypce0"
            target="_blank"
            rel="noopener noreferrer"
            className="underline underline-offset-2 hover:text-neutral-400"
          >
            Message @crypce0
          </a>{" "}
          with your signature.
        </p>
      </div>
    </div>
  );
}
