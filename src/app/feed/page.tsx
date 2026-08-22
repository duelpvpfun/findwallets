import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Link from "next/link";
import WalletConnectButton from "@/components/WalletConnectButton";
import SiteNav from "@/components/SiteNav";
import FeedTerminal from "@/components/feed/FeedTerminal";
import { fetchAlertFeed, fetchAlertSummary, fetchCallCards } from "@/lib/db/alerts";
import { alertsArePublic } from "@/lib/alerts/config";
import { isAdminRequest } from "@/lib/adminAuth";
import { isDbConfigured } from "@/lib/db";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Live smart money feed",
  description:
    "Every token several proven Solana wallets buy inside minutes of each other, live, with the market cap each call fired at.",
  alternates: { canonical: "/feed" },
  // Flipped to indexable in the same release that sets ALERTS_PUBLIC.
  robots: { index: false, follow: false },
};

const CHAIN = "solana";
const INITIAL_ALERTS = 60;

/**
 * The live feed.
 *
 * Owner-only until `ALERTS_PUBLIC=1`, and rendered exactly as it will be in
 * public so what gets reviewed is the real page. Server-rendered first so the
 * feed is on screen immediately rather than after a fetch resolves.
 *
 * The tier scoreboard is deliberately NOT here — it lives on /admin. It is
 * operator information: which tier is worth reading is a question about how we
 * tune the product, and publishing an "average peak" invites reading it as a
 * return anyone actually made.
 *
 * Both queries run in sequence. A `Promise.all` of database calls is a latent
 * hang: postgres.js pipelines onto a pool of 3, and a fan-out wider than the
 * pool stops Supabase's transaction pooler answering at all. See AGENTS.md.
 */
export default async function FeedPage() {
  if (!alertsArePublic() && !(await isAdminRequest())) notFound();

  const configured = isDbConfigured();
  const alerts = configured ? await fetchAlertFeed(CHAIN, INITIAL_ALERTS) : [];
  const summary = configured ? await fetchAlertSummary(CHAIN) : null;
  // The podium's 24h top three. Resolved once here rather than on every poll:
  // after this the client re-derives it from the rows it is already fetching,
  // so the live feed never carries a third query per tick.
  const podiumSeed = configured ? await fetchCallCards(CHAIN, 1, 3) : [];

  const channel = process.env.NEXT_PUBLIC_TELEGRAM_CHANNEL;
  const telegramUrl = channel ? `https://t.me/${channel.replace(/^@/, "")}` : null;

  return (
    <div className="flex min-h-screen flex-col bg-neutral-950 text-neutral-100">
      <div className="pointer-events-none fixed inset-0 overflow-hidden">
        <div className="absolute -top-40 left-1/2 h-[500px] w-[900px] -translate-x-1/2 rounded-full bg-blue-600/10 blur-3xl" />
      </div>

      <header className="relative border-b border-neutral-800/80 bg-neutral-950/80 backdrop-blur-sm">
        <div className="mx-auto flex max-w-6xl items-center gap-2 px-4 py-3 sm:px-6">
          <Link
            href="/"
            className="flex min-w-0 flex-1 items-center gap-3 rounded-lg transition-opacity hover:opacity-80"
          >
            <span className="alpha-glow select-none text-2xl leading-none font-semibold text-white">
              α
            </span>
            {/* Same rule as the scan page: on a phone the wordmark yields to the
                centred tabs, and the α carries the brand on its own. */}
            <div className="hidden sm:block">
              <div className="text-sm font-semibold leading-tight text-neutral-50">
                Alpha Wallet Finder
              </div>
              <div className="text-[11px] leading-tight text-neutral-500">Smart money feed</div>
            </div>
          </Link>

          <SiteNav active="feed" />

          <div className="flex min-w-0 flex-1 items-center justify-end gap-2">
            <WalletConnectButton />
            {telegramUrl ? (
              <a
                href={telegramUrl}
                target="_blank"
                rel="noopener noreferrer"
                aria-label="Smart money alerts on Telegram"
                title="Smart money alerts on Telegram"
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-neutral-800 bg-neutral-900 text-neutral-400 transition-colors hover:border-neutral-700 hover:text-[#29a9eb]"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                  <path d="M21.94 4.3a1.2 1.2 0 0 0-1.63-1.15L2.9 9.9c-1.06.42-1.05 1.93.02 2.33l3.9 1.47 1.5 4.72c.3.96 1.53 1.2 2.17.43l2.1-2.53 4 2.95c.79.58 1.92.14 2.11-.83l3.24-14.14ZM8.7 13.2l8.2-5.1-6.42 6.02a1.2 1.2 0 0 0-.36.72l-.28 2.02-1.14-3.66Z" />
                </svg>
              </a>
            ) : null}
            <a
              href="https://x.com/crypce0"
              target="_blank"
              rel="noopener noreferrer"
              aria-label="@crypce0 on X"
              title="Built by @crypce0"
              className="hidden h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-neutral-800 bg-neutral-900 text-neutral-400 transition-colors hover:border-neutral-700 hover:text-neutral-50 sm:flex"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
              </svg>
            </a>
          </div>
        </div>
      </header>

      <main className="relative mx-auto w-full max-w-6xl flex-1 px-3 py-4 sm:px-6 sm:py-6">
        {configured ? (
          <FeedTerminal
            initialAlerts={alerts}
            trackedWallets={summary?.trackedWallets ?? 0}
            podiumSeed={podiumSeed}
          />
        ) : (
          <p className="rounded-xl border border-dashed border-neutral-800 bg-neutral-900/20 px-4 py-10 text-center text-sm text-neutral-400">
            Not configured on this deployment.
          </p>
        )}

        <p className="mt-4 text-[11px] leading-relaxed text-neutral-600">
          A row fires when several wallets with a proven record buy the same token inside minutes of
          each other. Repeat buys from one wallet count once. A wallet that already sold still
          counts and is marked. Peak is measured against the cap when we called it.
        </p>
      </main>

      <footer className="relative mt-auto border-t border-neutral-800/80 bg-neutral-950/80">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-4 py-3 sm:px-6">
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
