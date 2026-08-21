"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import type { Chain } from "@/lib/types";
import TradersTable from "@/components/TradersTable";
import ScanProgress from "@/components/ScanProgress";
import PaywallDialog from "@/components/PaywallDialog";
import WalletTicker from "@/components/WalletTicker";
import RadarSweep from "@/components/RadarSweep";
import OnboardingCarousel, {
  shouldShowOnboarding,
  markOnboardingSeen,
} from "@/components/OnboardingCarousel";
import WalletConnectButton from "@/components/WalletConnectButton";
import { useAccount } from "@/components/AccountProvider";
import { detectAddressFamily } from "@/lib/chains";
import { clearScan, loadScan, saveScan, type CachedScan } from "@/lib/scanCache";
import { consumeScanStream } from "@/lib/scanStream";
import { CLAIM_STORAGE_KEY, OWNER_STORAGE_KEY, TIER_OPTIONS } from "@/lib/tiers";

const LIMIT_OPTIONS = [100, 250, 500] as const;
const PAYMENTS_ENABLED = process.env.NEXT_PUBLIC_PAYMENTS_ENABLED === "true";

const CHAINS: Array<{ value: Chain; label: string; short: string; dot: string }> = [
  { value: "solana", label: "Solana", short: "SOL", dot: "bg-violet-400" },
  { value: "bsc", label: "BNB Chain", short: "BNB", dot: "bg-yellow-400" },
  { value: "base", label: "Base", short: "BASE", dot: "bg-blue-400" },
];

/** A token we've already scanned, replayable from cache as a free sample. */
interface ShowcaseToken {
  chain: Chain;
  address: string;
  symbol: string;
  name: string;
  walletCount: number;
}

const PLACEHOLDERS: Record<Chain, string> = {
  solana: "Paste token contract address (CA)…",
  bsc: "Paste BEP-20 token contract address (0x…)…",
  base: "Paste Base token contract address (0x…)…",
};

export default function Home() {
  const { user, balance, refresh: refreshAccount } = useAccount();
  const [chain, setChain] = useState<Chain>("solana");
  const [address, setAddress] = useState("");
  const [limit, setLimit] = useState<(typeof LIMIT_OPTIONS)[number]>(100);
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState<{ found: number; requested: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<CachedScan | null>(null);
  const [ownerKey, setOwnerKey] = useState<string | null>(null);
  const [claim, setClaim] = useState<{ token: string; tier: number } | null>(null);
  const [paywallOpen, setPaywallOpen] = useState(false);
  const [autoChain, setAutoChain] = useState<Chain | null>(null);
  const [samples, setSamples] = useState<ShowcaseToken[]>([]);
  // Greet first-time visitors with the walkthrough unless they opted out.
  // Closed during SSR and the first client render so hydration matches; the
  // localStorage read happens in a frame callback, after paint.
  const [welcomeOpen, setWelcomeOpen] = useState(false);
  const addressRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const id = requestAnimationFrame(() => setWelcomeOpen(shouldShowOnboarding()));
    return () => cancelAnimationFrame(id);
  }, []);

  // Restore owner key / unused credit, and let the owner install their key via ?key=…
  useEffect(() => {
    let cancelled = false;

    async function restore() {
      const params = new URLSearchParams(window.location.search);
      const keyFromUrl = params.get("key");
      if (keyFromUrl !== null) {
        // `?key=` with an empty value clears it, so the owner can see the buyer's flow.
        if (keyFromUrl) localStorage.setItem(OWNER_STORAGE_KEY, keyFromUrl);
        else localStorage.removeItem(OWNER_STORAGE_KEY);
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
        // Only forget a credit that is provably gone. A reservation still held by
        // a scan that crashed is *not* spent from the buyer's point of view, and
        // wiping the token here would strand them at the paywall holding a
        // purchase they can no longer name.
        else if (status.reason === "reservation_pending") {
          setClaim({ token: parsed.token, tier: status.tier });
        } else if (status.reason === "not_found" || status.reason === "already_used") {
          localStorage.removeItem(CLAIM_STORAGE_KEY);
        }
      } catch {
        // offline or transient failure — keep the stored credit for the next visit
      }
    }

    void restore();
    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * Folds a browser-held claim token into the signed-in account.
   *
   * localStorage is cleared only AFTER the server confirms, so a failed request
   * can never leave a buyer with neither a local token nor an account credit.
   * `safeToForget` also covers a token that turns out to be spent or unknown —
   * in both cases the browser copy is worthless and keeping it just strands the
   * user at a paywall holding a purchase they can't name.
   */
  useEffect(() => {
    if (!user || !claim) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/auth/absorb", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ claimToken: claim.token }),
        });
        const data = await res.json().catch(() => null);
        if (cancelled || !res.ok || !data?.safeToForget) return;
        localStorage.removeItem(CLAIM_STORAGE_KEY);
        setClaim(null);
        await refreshAccount();
      } catch {
        // Keep the local token for the next visit rather than risk losing it.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [user, claim, refreshAccount]);

  const runSearch = useCallback(
    async (ca: string, searchChain: Chain, searchLimit: number, claimToken?: string | null) => {
      if (!ca.trim()) return;
      setLoading(true);
      setProgress(null);
      setError(null);
      try {
        const qs = new URLSearchParams({
          address: ca.trim(),
          limit: String(searchLimit),
          chain: searchChain,
          stream: "1",
        });
        // Credentials go in headers, never the query string, so they can't leak
        // through access logs, proxies or Referer headers.
        const headers: Record<string, string> = {};
        if (claimToken) headers["x-claim-token"] = claimToken;
        if (ownerKey) headers["x-owner-key"] = ownerKey;
        const res = await fetch(`/api/top-traders?${qs}`, { headers });

        // Errors (rate limit, paywall, bad address) are still plain JSON.
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          if (res.status === 402) {
            localStorage.removeItem(CLAIM_STORAGE_KEY);
            setClaim(null);
            setPaywallOpen(true);
          }
          setError(data.error ?? "Something went wrong.");
          setResult(null);
          return;
        }

        const data = await consumeScanStream(res, (found, requested) =>
          setProgress({ found, requested })
        );
        if ("error" in data) {
          setError(data.error);
          setResult(null);
          return;
        }
        // Only the purchase the SERVER says it spent. A signed-in buyer's
        // account balance is tried first, so a claim token still in the browser
        // may be completely untouched — forgetting it here would destroy it.
        if (data.creditSource === "claim_token" && claimToken) {
          localStorage.removeItem(CLAIM_STORAGE_KEY);
          setClaim(null);
        }
        if (data.creditSource === "account") void refreshAccount();
        // A valid address on the wrong chain returns nothing; the credit is
        // untouched, so tell the user rather than leaving them guessing.
        if (data.note) setError(data.note);
        setResult(data);
        // A refresh or a discarded tab must not destroy a paid result.
        if (data.traders.length > 0) saveScan(data);
      } catch {
        setError("Failed to reach the server.");
      } finally {
        setLoading(false);
        setProgress(null);
      }
    },
    [ownerKey, refreshAccount]
  );

  // A buyer who reloads, or whose tab the browser discarded, gets their scan
  // back rather than losing a purchase that is already marked consumed.
  useEffect(() => {
    const id = requestAnimationFrame(() => {
      const cached = loadScan();
      if (!cached) return;
      setResult(cached);
      setChain(cached.token.chain);
      setAddress(cached.token.address);
    });
    return () => cancelAnimationFrame(id);
  }, []);

  // Tokens we've already scanned, offered as free samples.
  useEffect(() => {
    let cancelled = false;
    fetch("/api/showcase")
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!cancelled && Array.isArray(data?.tokens)) setSamples(data.tokens);
      })
      .catch(() => {
        /* samples are optional */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * Replays a cached scan. Never touches a credit or a paid upstream API, so
   * visitors can see the real product before deciding to buy.
   */
  const runPreview = useCallback(async (sample: ShowcaseToken) => {
    setLoading(true);
    setError(null);
    setChain(sample.chain);
    setAddress(sample.address);
    try {
      const qs = new URLSearchParams({ chain: sample.chain, address: sample.address });
      const res = await fetch(`/api/preview?${qs}`);
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Preview unavailable.");
        setResult(null);
        return;
      }
      setResult(data);
    } catch {
      setError("Failed to reach the server.");
    } finally {
      setLoading(false);
    }
  }, []);

  /** True when the signed-in account already holds a credit for this size. */
  const accountCovers = (size: number) => (balance?.bestTier ?? 0) >= size;

  /**
   * Owners scan free; everyone else needs an unspent credit covering the size,
   * from their account or from a claim token. Entitlement is still decided
   * server-side — this only decides whether to show the paywall first.
   */
  function startSearch(ca: string, searchChain: Chain) {
    if (!ca.trim()) return;
    if (!PAYMENTS_ENABLED || ownerKey) {
      void runSearch(ca, searchChain, limit);
      return;
    }
    // The account balance is passed nothing: resolveAccess reserves from it.
    // The claim token is still sent when one exists, as the fallback the server
    // uses if the balance has nothing big enough.
    if (accountCovers(limit) || (claim && claim.tier >= limit)) {
      void runSearch(ca, searchChain, limit, claim?.token ?? null);
      return;
    }
    setPaywallOpen(true);
  }

  function handlePaid(claimToken: string, tier: number) {
    localStorage.setItem(CLAIM_STORAGE_KEY, JSON.stringify({ token: claimToken, tier }));
    setClaim({ token: claimToken, tier });
    setPaywallOpen(false);
    // A multi-scan purchase puts the spares straight onto the account.
    void refreshAccount();
    const paidLimit = (LIMIT_OPTIONS.find((o) => o === tier) ?? limit) as (typeof LIMIT_OPTIONS)[number];
    setLimit(paidLimit);
    void runSearch(address, chain, paidLimit, claimToken);
  }

  /**
   * Address formats are disjoint between Solana and EVM, so a paste tells us
   * the family with certainty. Only the wrong-family case switches: a 0x address
   * is valid on both BNB Chain and Base, so an EVM pick is left alone.
   */
  function handleAddressChange(value: string) {
    setAddress(value);
    const family = detectAddressFamily(value.trim());
    if (!family) {
      setAutoChain(null);
      return;
    }
    if (family === "solana" && chain !== "solana") {
      setChain("solana");
      setAutoChain("solana");
    } else if (family === "evm" && chain === "solana") {
      setChain("bsc");
      setAutoChain("bsc");
    } else {
      setAutoChain(null);
    }
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    startSearch(address, chain);
  }

  /** Clears the current scan so the search screen is reachable again. */
  function resetToHome() {
    setResult(null);
    setAddress("");
    setError(null);
    clearScan();
  }

  return (
    <div className="flex min-h-screen flex-col bg-neutral-950 text-neutral-100">
      {/* Ambient background glow */}
      <div className="pointer-events-none fixed inset-0 overflow-hidden">
        <div className="absolute -top-40 left-1/2 h-[500px] w-[900px] -translate-x-1/2 rounded-full bg-blue-600/10 blur-3xl" />
        <div className="absolute top-96 right-0 h-[400px] w-[500px] rounded-full bg-emerald-500/5 blur-3xl" />
      </div>

      {/* z-40: `backdrop-blur` makes this a stacking context, so without an
          explicit layer the wallet dropdown inside it paints *under* <main>
          and the hero heading covers it. Below every modal (z-50 and up). */}
      <header className="relative z-40 border-b border-neutral-800/80 bg-neutral-950/80 backdrop-blur-sm">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-4 py-3 sm:px-6 sm:py-4">
          <button
            onClick={resetToHome}
            aria-label="Back to home"
            className="flex items-center gap-3 rounded-lg text-left transition-opacity hover:opacity-80"
          >
            <span className="alpha-glow select-none text-3xl leading-none font-semibold text-white">
              α
            </span>
            <div>
              <h1 className="text-sm font-semibold leading-tight text-neutral-50">
                Alpha Wallet Finder
              </h1>
              <p className="hidden text-[11px] leading-tight text-neutral-500 sm:block">
                Multichain top-trader lookup
              </p>
            </div>
          </button>
          <div className="flex items-center gap-2">
            <WalletConnectButton />
            <Link
              href="/profile"
              title="Your purchases and saved results"
              className="flex items-center gap-1.5 rounded-md border border-neutral-800 px-2.5 py-1.5 text-xs font-medium text-neutral-400 transition-colors hover:border-neutral-700 hover:text-neutral-200"
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <circle cx="12" cy="8" r="3.5" />
                <path d="M5 20c0-3.3 3.1-5.5 7-5.5s7 2.2 7 5.5" />
              </svg>
              <span className="hidden sm:inline">Profile</span>
            </Link>
            {/* Persistent way back into the walkthrough — the modal only ever
                greets someone once, so this is how anyone re-opens it. */}
            <button
              onClick={() => setWelcomeOpen(true)}
              className="flex items-center gap-1.5 rounded-md border border-neutral-800 px-2.5 py-1.5 text-xs font-medium text-neutral-400 transition-colors hover:border-neutral-700 hover:text-neutral-200"
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="9.5" />
                <path d="M9.6 9.2a2.5 2.5 0 1 1 3.4 2.3c-.6.3-1 .9-1 1.6v.4" strokeLinecap="round" />
                <path d="M12 17h.01" strokeLinecap="round" />
              </svg>
              <span className="hidden sm:inline">How it works</span>
            </button>
            <a
              href="https://x.com/crypce0"
              target="_blank"
              rel="noopener noreferrer"
              className="hidden items-center gap-1.5 rounded-md border border-neutral-800 px-3 py-1.5 text-xs font-medium text-neutral-400 hover:border-neutral-700 hover:text-neutral-200 sm:flex"
            >
              Built by @crypce0
            </a>
          </div>
        </div>
      </header>

      <main className="relative mx-auto w-full max-w-7xl flex-1 px-4 py-6 sm:px-6 sm:py-10">
        {!result && (
          <div className="relative mx-auto mb-6 max-w-2xl text-center sm:mb-8">
            {/* The only decorative sweep on the page, behind text at very low
                opacity — and hidden while a scan runs, so the sweep on the
                progress panel is never competing with a second one. */}
            {!loading && (
              <div className="pointer-events-none absolute inset-0 hidden items-center justify-center opacity-[0.18] sm:flex">
                <RadarSweep size={340} />
              </div>
            )}
            <h2 className="relative text-xl font-semibold tracking-tight text-neutral-50 sm:text-3xl">
              Find the wallets behind every winning trade
            </h2>
            <p className="relative mt-2 text-sm text-neutral-400 sm:text-base">
              Paste any memecoin contract address and instantly rank its top 100 to 500 traders by
              realized PNL.
            </p>
            <div className="relative mt-4 flex flex-wrap items-center justify-center gap-2">
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
          <div className="flex shrink-0 overflow-hidden rounded-xl border border-neutral-800 bg-neutral-950">
            {CHAINS.map((c) => (
              <button
                key={c.value}
                type="button"
                onClick={() => {
                  setChain(c.value);
                  setAutoChain(null);
                }}
                title={c.label}
                className={`flex flex-1 items-center justify-center gap-1.5 px-3 py-3 text-sm font-medium transition-colors sm:flex-none ${
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
              ref={addressRef}
              value={address}
              onChange={(e) => handleAddressChange(e.target.value)}
              placeholder={PLACEHOLDERS[chain]}
              spellCheck={false}
              className="w-full truncate rounded-xl border border-neutral-800 bg-neutral-950 py-3 pl-10 pr-3 font-mono text-sm text-neutral-100 outline-none transition-colors placeholder:font-sans placeholder:text-xs focus:border-blue-500/60 focus:ring-2 focus:ring-blue-500/20 sm:placeholder:text-sm"
            />
          </div>
          <div className="flex gap-2">
            <div className="relative flex-1 sm:flex-none">
              <select
                value={limit}
                onChange={(e) => setLimit(Number(e.target.value) as (typeof LIMIT_OPTIONS)[number])}
                className="h-full w-full appearance-none rounded-xl border border-neutral-800 bg-neutral-950 py-3 pl-3 pr-8 text-sm font-medium text-neutral-100 outline-none transition-colors focus:border-blue-500/60 focus:ring-2 focus:ring-blue-500/20"
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
              ) : PAYMENTS_ENABLED &&
                !ownerKey &&
                !accountCovers(limit) &&
                !(claim && claim.tier >= limit) ? (
                `Unlock Top ${limit}`
              ) : (
                "Find Wallets"
              )}
            </button>
          </div>
        </form>

        {autoChain && (
          <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-neutral-400">
            <span className="rounded-full border border-blue-900/60 bg-blue-950/30 px-3 py-1 font-medium text-blue-300">
              Switched to {CHAINS.find((c) => c.value === autoChain)?.label} to match this address
            </span>
            {autoChain === "bsc" && (
              <button
                type="button"
                onClick={() => {
                  setChain("base");
                  setAutoChain(null);
                }}
                className="text-neutral-500 underline underline-offset-2 transition-colors hover:text-neutral-300"
              >
                It&apos;s on Base
              </button>
            )}
          </div>
        )}

        {(ownerKey || claim || (balance?.total ?? 0) > 0) && (
          <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
            <span className="rounded-full border border-emerald-900/60 bg-emerald-950/30 px-3 py-1 font-medium text-emerald-300">
              {ownerKey
                ? "Owner access · unlimited free scans"
                : balance && balance.total > 0
                ? `${balance.total} scan${balance.total === 1 ? "" : "s"} on your account · up to Top ${balance.bestTier}`
                : `Credit ready · Top ${claim!.tier}`}
            </span>
            {ownerKey && (
              <button
                type="button"
                onClick={() => {
                  localStorage.removeItem(OWNER_STORAGE_KEY);
                  setOwnerKey(null);
                }}
                className="text-neutral-500 underline underline-offset-2 transition-colors hover:text-neutral-300"
              >
                Exit owner mode
              </button>
            )}
          </div>
        )}

        {!result && !error && (
          <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-neutral-500">
            {samples.length > 0 && (
              <>
                <span className="flex items-center gap-1.5">
                  <span className="rounded-md bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-emerald-400">
                    Free
                  </span>
                  Try a real scan:
                </span>
                {samples.map((s) => (
                  <button
                    key={`${s.chain}-${s.address}`}
                    onClick={() => void runPreview(s)}
                    title={`${s.name} · ${s.walletCount} wallets already scanned`}
                    className="flex items-center gap-1.5 rounded-full border border-neutral-800 bg-neutral-900/60 px-3 py-1 font-mono text-neutral-400 transition-colors hover:border-emerald-700/60 hover:text-neutral-200"
                  >
                    <span
                      className={`h-1.5 w-1.5 rounded-full ${
                        CHAINS.find((c) => c.value === s.chain)?.dot ?? "bg-neutral-500"
                      }`}
                    />
                    ${s.symbol}
                  </button>
                ))}
              </>
            )}
          </div>
        )}

        {error && (
          <div
            role="alert"
            className="animate-fade-in mt-4 flex items-start gap-3 rounded-xl border border-rose-900/60 bg-rose-950/25 px-4 py-3.5"
          >
            <AlertIcon className="mt-0.5 h-4 w-4 shrink-0 text-rose-400" />
            <div className="min-w-0 flex-1">
              <p className="text-sm leading-relaxed text-rose-200">{error}</p>
              {/* A failed scan never spends the credit, and saying so is the
                  difference between an annoyance and a support message. */}
              <p className="mt-1 text-[11px] text-rose-300/60">
                Nothing was charged for a scan that returned nothing.
              </p>
            </div>
            <button
              onClick={() => setError(null)}
              aria-label="Dismiss"
              className="-mr-1 -mt-1 shrink-0 rounded-md p-1.5 text-rose-400/60 transition-colors hover:bg-rose-500/10 hover:text-rose-300"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
                <path d="M18 6 6 18M6 6l12 12" />
              </svg>
            </button>
          </div>
        )}

        <div className="mt-8">
          {result ? (
            <div className="animate-fade-in">
              {result.isPreview && (
                <div className="mb-4 flex flex-wrap items-center gap-3 rounded-xl border border-emerald-900/50 bg-emerald-950/20 px-4 py-3">
                  <span className="rounded-md bg-emerald-500/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-emerald-400">
                    Free sample
                  </span>
                  <span className="text-sm text-neutral-300">
                    Real results from a previous scan, capped at {result.previewLimit ?? 25}{" "}
                    wallets.
                  </span>
                  <button
                    onClick={resetToHome}
                    className="ml-auto text-xs font-medium text-emerald-400 hover:text-emerald-300"
                  >
                    Scan your own token →
                  </button>
                </div>
              )}
              <TradersTable
                token={result.token}
                traders={result.traders}
                isDemoData={result.isDemoData}
                histories={result.histories}
                scanSession={result.scanSession}
                partial={result.partial}
                requestedCount={result.requestedCount}
                onBack={resetToHome}
              />
            </div>
          ) : (
            loading ? (
              <ScanProgress progress={progress} chain={chain} limit={limit} />
            ) : (
              <>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-3 sm:gap-4">
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
                <WalletTicker />
              </>
            )
          )}
        </div>
      </main>

      <footer className="relative mt-auto border-t border-neutral-800/80 bg-neutral-950/80">
        <div className="mx-auto flex max-w-7xl flex-col items-center justify-between gap-2 px-4 py-4 sm:flex-row sm:gap-3 sm:px-6 sm:py-5">
          <a
            href="https://x.com/crypce0"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-2 text-xs font-medium text-neutral-400 transition-colors hover:text-neutral-100"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true" className="h-4 w-4 fill-current">
              <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
            </svg>
            @crypce0
          </a>
          <p className="text-xs text-neutral-500">Built for the trenches 🪖</p>
        </div>
      </footer>

      {welcomeOpen && (
        <OnboardingCarousel
          samples={samples}
          onClose={() => setWelcomeOpen(false)}
          onRunSample={(sample) => {
            setWelcomeOpen(false);
            void runPreview(sample);
          }}
          onUseAddress={(value) => {
            setWelcomeOpen(false);
            markOnboardingSeen();
            handleAddressChange(value);
            // Deliberately not auto-submitted: on a token of their own the next
            // step is the paywall, and springing that on someone who just asked
            // to "load it in" is not the same thing they asked for.
            requestAnimationFrame(() => addressRef.current?.focus());
          }}
        />
      )}

      {paywallOpen && (
        <PaywallDialog
          initialLimit={limit}
          signedIn={Boolean(user)}
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
