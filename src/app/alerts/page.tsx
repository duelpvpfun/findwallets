import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Link from "next/link";
import WalletConnectButton from "@/components/WalletConnectButton";
import AlertsClient from "@/components/alerts/AlertsClient";
import { fetchAlertFeed, fetchAlertSummary, fetchTierScoreboard } from "@/lib/db/alerts";
import { alertsArePublic } from "@/lib/alerts/config";
import { isAdminRequest } from "@/lib/adminAuth";
import { isDbConfigured } from "@/lib/db";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Smart money alerts",
  description:
    "Live alerts when several proven Solana wallets buy the same token inside minutes of each other, with every call's market cap tracked from the moment it fired.",
  alternates: { canonical: "/alerts" },
  // Flipped to indexable in the same release that sets ALERTS_PUBLIC. Metadata
  // is static, so this stays conservative until then rather than risking the
  // page being crawled while it is still owner-only.
  robots: { index: false, follow: false },
};

const CHAIN = "solana";
const INITIAL_ALERTS = 40;

/**
 * The alert feed.
 *
 * Owner-only until `ALERTS_PUBLIC=1`, and rendered exactly as it will be in
 * public so that what gets reviewed is the real page rather than a preview of
 * it. Once flipped it costs nothing per viewer beyond an indexed read, and it
 * is the top-of-funnel for both the paid scanner and the Telegram channel.
 *
 * Wallet addresses are masked at the database read either way — the curated
 * wallet list is the paid product, and this page never resolves one.
 *
 * Server-rendered so a reload never shows an empty shell, then polled client
 * side. Every query below runs one after another: a `Promise.all` of database
 * calls is a latent hang here — postgres.js pipelines onto a pool of 3, and a
 * fan-out wider than the pool stops Supabase's transaction pooler answering at
 * all. See AGENTS.md.
 */
export default async function AlertsPage() {
  // Owner-only until ALERTS_PUBLIC is set. `notFound()` rather than a login
  // prompt: an unreleased page should not advertise that it exists, and the
  // owner already holds the /admin cookie that opens it.
  if (!alertsArePublic() && !(await isAdminRequest())) notFound();

  const configured = isDbConfigured();

  const alerts = configured ? await fetchAlertFeed(CHAIN, INITIAL_ALERTS) : [];
  const summary = configured ? await fetchAlertSummary(CHAIN) : null;
  const scoreboard = configured ? await fetchTierScoreboard(CHAIN) : [];

  const channel = process.env.NEXT_PUBLIC_TELEGRAM_CHANNEL;
  const telegramUrl = channel
    ? `https://t.me/${channel.replace(/^@/, "").replace(/^https?:\/\/t\.me\//, "")}`
    : null;

  return (
    <div className="flex min-h-screen flex-col bg-neutral-950 text-neutral-100">
      <div className="pointer-events-none fixed inset-0 overflow-hidden">
        <div className="absolute -top-40 left-1/2 h-[500px] w-[900px] -translate-x-1/2 rounded-full bg-blue-600/10 blur-3xl" />
      </div>

      <header className="relative border-b border-neutral-800/80 bg-neutral-950/80 backdrop-blur-sm">
        <div className="mx-auto flex max-w-4xl items-center justify-between gap-3 px-4 py-3 sm:px-6 sm:py-4">
          <Link
            href="/"
            aria-label="Back to scanning"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-neutral-800 bg-neutral-900 text-neutral-400 transition-colors hover:border-neutral-700 hover:bg-neutral-800 hover:text-neutral-100"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M19 12H5m0 0 6-6m-6 6 6 6" />
            </svg>
          </Link>
          <Link href="/" className="mr-auto flex items-center gap-3 rounded-lg transition-opacity hover:opacity-80">
            <span className="alpha-glow select-none text-2xl leading-none font-semibold text-white">
              α
            </span>
            <div>
              <div className="text-sm font-semibold leading-tight text-neutral-50">
                Alpha Wallet Finder
              </div>
              <div className="text-[11px] leading-tight text-neutral-500">Smart money alerts</div>
            </div>
          </Link>
          <WalletConnectButton />
        </div>
      </header>

      <main className="relative mx-auto w-full max-w-4xl flex-1 px-4 py-6 sm:px-6 sm:py-8">
        <div className="mb-6">
          <h1 className="text-xl font-semibold text-neutral-50 sm:text-2xl">
            Where smart money is going
          </h1>
          <p className="mt-2 max-w-2xl text-sm leading-relaxed text-neutral-400">
            Every wallet in our database with a proven record — a 4x+ win, two 3x+ wins, or a 2x
            with $5K+ profit — is streamed live. When several of them buy the same token inside
            minutes of each other, it lands here.
          </p>
        </div>

        {configured ? (
          <AlertsClient
            initialAlerts={alerts}
            initialSummary={summary}
            initialScoreboard={scoreboard}
            telegramUrl={telegramUrl}
          />
        ) : (
          <p className="rounded-xl border border-dashed border-neutral-800 bg-neutral-900/20 px-4 py-10 text-center text-sm text-neutral-400">
            The alert stream is not configured on this deployment.
          </p>
        )}

        <section className="mt-8 rounded-xl border border-neutral-800/80 bg-neutral-900/30 p-4 sm:p-5">
          <h2 className="text-sm font-semibold text-neutral-200">How an alert fires</h2>
          <ul className="mt-3 space-y-1.5 text-xs leading-relaxed text-neutral-400">
            <li>
              <span className="font-medium text-emerald-300">2 wallets in 2 minutes</span> — a
              burst. Two proven traders landing on the same token that close together is either
              shared information or the same signal read twice.
            </li>
            <li>
              <span className="font-medium text-emerald-300">3 wallets in 5 minutes</span> — the
              same shape, harder to dismiss as coincidence.
            </li>
            <li>
              <span className="font-medium text-amber-300">4, 5 or 6 wallets in an hour</span> —
              accumulation. Slower, but four independent winners is a much stronger claim than two.
            </li>
          </ul>
          <p className="mt-3 text-xs leading-relaxed text-neutral-500">
            Repeat buys from one wallet count once. Buys under $50 are ignored — proven wallets
            routinely send a dust buy to test a token before committing. A wallet that has already
            sold still counts, and is marked so you know before you chase the entry.
          </p>
        </section>
      </main>

      <footer className="relative mt-auto border-t border-neutral-800/80 bg-neutral-950/80">
        <div className="mx-auto flex max-w-4xl items-center justify-between gap-3 px-4 py-4 sm:px-6">
          <Link href="/" className="text-xs font-medium text-neutral-400 transition-colors hover:text-neutral-100">
            ← Scan a token
          </Link>
          <a
            href="https://x.com/crypce0"
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-neutral-500 transition-colors hover:text-neutral-300"
          >
            @crypce0
          </a>
        </div>
      </footer>
    </div>
  );
}
