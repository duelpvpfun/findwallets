"use client";

import { useCallback, useEffect, useState } from "react";
import type { Chain, TokenMeta, WalletHistory, WalletTrader } from "@/lib/types";
import TradersTable from "@/components/TradersTable";
import PaywallDialog from "@/components/PaywallDialog";
import { CLAIM_STORAGE_KEY, OWNER_STORAGE_KEY, TIER_OPTIONS } from "@/lib/tiers";

const LIMIT_OPTIONS = [50, 100, 250, 500] as const;
const PAYMENTS_ENABLED = process.env.NEXT_PUBLIC_PAYMENTS_ENABLED === "true";

const CHAINS: Array<{ value: Chain; label: string; short: string; dot: string }> = [
  { value: "solana", label: "Solana", short: "SOL", dot: "bg-violet-400" },
  { value: "bsc", label: "BNB Chain", short: "BNB", dot: "bg-yellow-400" },
  { value: "base", label: "Base", short: "BASE", dot: "bg-blue-400" },
];

const EXAMPLES: Record<Chain, { address: string; label: string }> = {
  solana: { address: "6p6xgHyF7AeE6TZkSmFsko444wqoP15icUSqi2jfGiPN", label: "$TRUMP" },
  bsc: { address: "0x55d398326f99059fF775485246999027B3197955", label: "$USDT" },
  base: { address: "0x4200000000000000000000000000000000000006", label: "$WETH" },
};

const PLACEHOLDERS: Record<Chain, string> = {
  solana: "Paste token contract address (CA)…",
  bsc: "Paste BEP-20 token contract address (0x…)…",
  base: "Paste Base token contract address (0x…)…",
};

export default function Home() {
  const [chain, setChain] = useState<Chain>("solana");
  const [address, setAddress] = useState("");
  const [limit, setLimit] = useState<(typeof LIMIT_OPTIONS)[number]>(100);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{
    token: TokenMeta;
    traders: WalletTrader[];
    isDemoData: boolean;
    histories?: Record<string, WalletHistory>;
    note?: string;
    scanSession?: string;
  } | null>(null);
  const [ownerKey, setOwnerKey] = useState<string | null>(null);
  const [claim, setClaim] = useState<{ token: string; tier: number } | null>(null);
  const [paywallOpen, setPaywallOpen] = useState(false);

  // Restore owner key / unused credit, and let the owner install their key via ?key=…
  useEffect(() => {
    let cancelled = false;

    async function restore() {
      const params = new URLSearchParams(window.location.search);
      const keyFromUrl = params.get("key");
      if (keyFromUrl) {
        localStorage.setItem(OWNER_STORAGE_KEY, keyFromUrl);
        params.delete("key");
        const qs = params.toString();
        window.history.replaceState({}, "", window.location.pathname + (qs ? `?${qs}` : ""));
      }
      const storedKey = localStorage.getItem(OWNER_STORAGE_KEY);
      if (!cancelled) setOwnerKey(storedKey);

      const stored = localStorage.getItem(CLAIM_STORAGE_KEY);
      if (!stored) return;
      let parsed: { token: string; tier: number };
      try {
        parsed = JSON.parse(stored);
      } catch {
        localStorage.removeItem(CLAIM_STORAGE_KEY);
        return;
      }
      // A credit is single-use, so verify it's still unspent before showing it.
      try {
        const res = await fetch(`/api/claim?claim=${encodeURIComponent(parsed.token)}`);
        const status = await res.json();
        if (cancelled) return;
        if (status.valid) setClaim({ token: parsed.token, tier: status.tier });
        else localStorage.removeItem(CLAIM_STORAGE_KEY);
      } catch {
        // offline or transient failure — keep the stored credit for the next visit
      }
    }

    void restore();
    return () => {
      cancelled = true;
    };
  }, []);

  const runSearch = useCallback(
    async (ca: string, searchChain: Chain, searchLimit: number, claimToken?: string | null) => {
      if (!ca.trim()) return;
      setLoading(true);
      setError(null);
      try {
        const qs = new URLSearchParams({
          address: ca.trim(),
          limit: String(searchLimit),
          chain: searchChain,
        });
        // Credentials go in headers, never the query string, so they can't leak
        // through access logs, proxies or Referer headers.
        const headers: Record<string, string> = {};
        if (claimToken) headers["x-claim-token"] = claimToken;
        if (ownerKey) headers["x-owner-key"] = ownerKey;
        const res = await fetch(`/api/top-traders?${qs}`, { headers });
        const data = await res.json();
        if (!res.ok) {
          if (res.status === 402) {
            localStorage.removeItem(CLAIM_STORAGE_KEY);
            setClaim(null);
            setPaywallOpen(true);
          }
          setError(data.error ?? "Something went wrong.");
          setResult(null);
          return;
        }
        // The credit is spent once the scan returns wallets.
        if (claimToken && data.traders?.length > 0) {
          localStorage.removeItem(CLAIM_STORAGE_KEY);
          setClaim(null);
        }
        // A valid address on the wrong chain returns nothing; the credit is
        // untouched, so tell the user rather than leaving them guessing.
        if (data.note) setError(data.note);
        setResult(data);
      } catch {
        setError("Failed to reach the server.");
      } finally {
        setLoading(false);
      }
    },
    [ownerKey]
  );

  /** Owners scan free; everyone else needs an unspent credit covering the size. */
  function startSearch(ca: string, searchChain: Chain) {
    if (!ca.trim()) return;
    if (!PAYMENTS_ENABLED || ownerKey) {
      void runSearch(ca, searchChain, limit);
      return;
    }
    if (claim && claim.tier >= limit) {
      void runSearch(ca, searchChain, limit, claim.token);
      return;
    }
    setPaywallOpen(true);
  }

  function handlePaid(claimToken: string, tier: number) {
    localStorage.setItem(CLAIM_STORAGE_KEY, JSON.stringify({ token: claimToken, tier }));
    setClaim({ token: claimToken, tier });
    setPaywallOpen(false);
    const paidLimit = (LIMIT_OPTIONS.find((o) => o === tier) ?? limit) as (typeof LIMIT_OPTIONS)[number];
    setLimit(paidLimit);
    void runSearch(address, chain, paidLimit, claimToken);
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    startSearch(address, chain);
  }

  return (
    <div className="min-h-screen bg-neutral-950 text-neutral-100">
      {/* Ambient background glow */}
      <div className="pointer-events-none fixed inset-0 overflow-hidden">
        <div className="absolute -top-40 left-1/2 h-[500px] w-[900px] -translate-x-1/2 rounded-full bg-blue-600/10 blur-3xl" />
        <div className="absolute top-96 right-0 h-[400px] w-[500px] rounded-full bg-emerald-500/5 blur-3xl" />
      </div>

      <header className="relative border-b border-neutral-800/80 bg-neutral-950/80 backdrop-blur-sm">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-6 py-4">
          <div className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-blue-500 to-violet-600 text-sm font-bold text-white shadow-lg shadow-blue-500/20">
              α
            </div>
            <div>
              <h1 className="text-sm font-semibold leading-tight text-neutral-50">Alpha Wallet Finder</h1>
              <p className="text-[11px] leading-tight text-neutral-500">Multichain top-trader lookup</p>
            </div>
          </div>
          <a
            href="https://x.com/crypce0"
            target="_blank"
            rel="noopener noreferrer"
            className="hidden items-center gap-1.5 rounded-md border border-neutral-800 px-3 py-1.5 text-xs font-medium text-neutral-400 hover:border-neutral-700 hover:text-neutral-200 sm:flex"
          >
            Built by @crypce0
          </a>
        </div>
      </header>

      <main className="relative mx-auto max-w-7xl px-6 py-10">
        {!result && (
          <div className="mx-auto mb-8 max-w-2xl text-center">
            <h2 className="text-2xl font-semibold tracking-tight text-neutral-50 sm:text-3xl">
              Find the wallets behind every winning trade
            </h2>
            <p className="mt-2 text-sm text-neutral-400 sm:text-base">
              Paste any memecoin contract address and instantly rank its top 100 to 500 traders by
              realized PNL.
            </p>
            <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
              <span className="text-xs text-neutral-500">Supported chains:</span>
              {CHAINS.map((c) => (
                <span
                  key={c.value}
                  className="flex items-center gap-1.5 rounded-full border border-neutral-800 bg-neutral-900/60 px-2.5 py-1 text-xs font-medium text-neutral-300"
                >
                  <span className={`h-1.5 w-1.5 rounded-full ${c.dot}`} />
                  {c.label}
                </span>
              ))}
            </div>
          </div>
        )}

        <form
          onSubmit={handleSubmit}
          className="flex flex-col gap-3 rounded-2xl border border-neutral-800 bg-neutral-900/60 p-3 shadow-xl shadow-black/20 backdrop-blur-sm sm:flex-row sm:items-center sm:p-3"
        >
          <div className="flex overflow-hidden rounded-xl border border-neutral-800 bg-neutral-950">
            {CHAINS.map((c) => (
              <button
                key={c.value}
                type="button"
                onClick={() => setChain(c.value)}
                title={c.label}
                className={`flex items-center gap-1.5 px-3 py-3 text-sm font-medium transition-colors ${
                  chain === c.value
                    ? "bg-blue-500/20 text-blue-200"
                    : "text-neutral-500 hover:bg-neutral-900 hover:text-neutral-300"
                }`}
              >
                <span className={`h-1.5 w-1.5 rounded-full ${c.dot}`} />
                {c.short}
              </button>
            ))}
          </div>
          <div className="relative flex-1">
            <SearchIcon className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-neutral-500" />
            <input
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              placeholder={PLACEHOLDERS[chain]}
              spellCheck={false}
              className="w-full rounded-xl border border-neutral-800 bg-neutral-950 py-3 pl-10 pr-3 font-mono text-sm text-neutral-100 outline-none transition-colors placeholder:font-sans focus:border-blue-500/60 focus:ring-2 focus:ring-blue-500/20"
            />
          </div>
          <div className="flex gap-2">
            <div className="relative">
              <select
                value={limit}
                onChange={(e) => setLimit(Number(e.target.value) as (typeof LIMIT_OPTIONS)[number])}
                className="h-full appearance-none rounded-xl border border-neutral-800 bg-neutral-950 py-3 pl-3 pr-8 text-sm font-medium text-neutral-100 outline-none transition-colors focus:border-blue-500/60 focus:ring-2 focus:ring-blue-500/20"
              >
                {LIMIT_OPTIONS.map((opt) => (
                  <option key={opt} value={opt}>
                    Top {opt}
                    {PAYMENTS_ENABLED && !ownerKey
                      ? ` · ${TIER_OPTIONS.find((t) => t.limit === opt)?.price ?? ""}`
                      : ""}
                  </option>
                ))}
              </select>
              <ChevronDownIcon className="pointer-events-none absolute right-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-neutral-500" />
            </div>
            <button
              type="submit"
              disabled={loading || !address.trim()}
              className="flex items-center justify-center gap-2 rounded-xl bg-gradient-to-b from-blue-500 to-blue-600 px-6 py-3 text-sm font-semibold text-white shadow-lg shadow-blue-600/25 transition-all hover:from-blue-400 hover:to-blue-500 hover:shadow-blue-500/30 disabled:cursor-not-allowed disabled:opacity-50 disabled:shadow-none"
            >
              {loading ? (
                <>
                  <Spinner />
                  Scanning…
                </>
              ) : PAYMENTS_ENABLED && !ownerKey && !(claim && claim.tier >= limit) ? (
                `Unlock Top ${limit}`
              ) : (
                "Find Wallets"
              )}
            </button>
          </div>
        </form>

        {(ownerKey || claim) && (
          <div className="mt-3 flex items-center gap-2 text-xs">
            <span className="rounded-full border border-emerald-900/60 bg-emerald-950/30 px-3 py-1 font-medium text-emerald-300">
              {ownerKey ? "Owner access · unlimited free scans" : `Credit ready · Top ${claim!.tier}`}
            </span>
          </div>
        )}

        {!result && !error && (
          <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-neutral-500">
            <span>Try:</span>
            <button
              onClick={() => {
                setAddress(EXAMPLES[chain].address);
                startSearch(EXAMPLES[chain].address, chain);
              }}
              className="rounded-full border border-neutral-800 bg-neutral-900/60 px-3 py-1 font-mono text-neutral-400 transition-colors hover:border-neutral-700 hover:text-neutral-200"
            >
              {EXAMPLES[chain].label}
            </button>
            {chain !== "solana" && (
              <span className="text-neutral-600">
                Note: on {CHAINS.find((c) => c.value === chain)?.label}, ranking covers the last 90
                days only (not all-time) and wallet balance data isn&apos;t available.
              </span>
            )}
          </div>
        )}

        {error && (
          <div className="mt-4 flex items-center gap-2 rounded-xl border border-rose-900/60 bg-rose-950/30 px-4 py-3 text-sm text-rose-300 animate-fade-in">
            <AlertIcon className="h-4 w-4 shrink-0" />
            {error}
          </div>
        )}

        <div className="mt-8">
          {result ? (
            <div className="animate-fade-in">
              <TradersTable
                token={result.token}
                traders={result.traders}
                isDemoData={result.isDemoData}
                histories={result.histories}
                scanSession={result.scanSession}
              />
            </div>
          ) : (
            loading ? (
              <div className="flex flex-col items-center justify-center gap-3 rounded-2xl border border-neutral-800/60 bg-neutral-900/30 px-4 py-24 text-center">
                <Spinner className="h-6 w-6 text-blue-400" />
                <p className="text-sm text-neutral-500">Fetching top traders…</p>
                {chain !== "solana" && limit > 100 && (
                  <p className="text-xs text-neutral-600">
                    Large {CHAINS.find((c) => c.value === chain)?.label} lookups are paginated 10 at
                    a time and can take up to ~30s.
                  </p>
                )}
              </div>
            ) : (
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                <FeatureCard
                  icon={<TargetIcon />}
                  title="Precise entry & exit"
                  description="Avg buy/sell price, market cap, and average multiple per wallet."
                />
                <FeatureCard
                  icon={<ChartIcon />}
                  title="Real PNL ranking"
                  description="Ranked by realized profit — not just holdings or activity."
                />
                <FeatureCard
                  icon={<ExportIcon />}
                  title="One-click export"
                  description="Select wallets and export straight to your tracking bot format."
                />
              </div>
            )
          )}
        </div>
      </main>

      {paywallOpen && (
        <PaywallDialog
          initialLimit={limit}
          onClose={() => setPaywallOpen(false)}
          onPaid={handlePaid}
        />
      )}
    </div>
  );
}

function FeatureCard({
  icon,
  title,
  description,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
}) {
  return (
    <div className="rounded-2xl border border-neutral-800/80 bg-neutral-900/30 p-5">
      <div className="mb-3 flex h-9 w-9 items-center justify-center rounded-lg bg-blue-500/10 text-blue-400">
        {icon}
      </div>
      <h3 className="text-sm font-semibold text-neutral-100">{title}</h3>
      <p className="mt-1 text-xs leading-relaxed text-neutral-500">{description}</p>
    </div>
  );
}

function Spinner({ className = "h-4 w-4" }: { className?: string }) {
  return (
    <svg className={`animate-spin ${className}`} viewBox="0 0 24 24" fill="none">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
      <path className="opacity-90" fill="currentColor" d="M4 12a8 8 0 018-8v3a5 5 0 00-5 5H4z" />
    </svg>
  );
}

function SearchIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="11" cy="11" r="7" />
      <path d="M21 21l-4.35-4.35" />
    </svg>
  );
}

function ChevronDownIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}

function AlertIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="12" r="10" />
      <path d="M12 8v4M12 16h.01" />
    </svg>
  );
}

function TargetIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="12" r="5" />
      <circle cx="12" cy="12" r="1" fill="currentColor" />
    </svg>
  );
}

function ChartIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M3 3v18h18" />
      <path d="M18 8l-5 5-3-3-4 4" />
    </svg>
  );
}

function ExportIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M12 3v12" />
      <path d="M7 8l5-5 5 5" />
      <path d="M5 21h14" />
    </svg>
  );
}
