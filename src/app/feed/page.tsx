import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Link from "next/link";
import WalletConnectButton from "@/components/WalletConnectButton";
import FeedTerminal from "@/components/feed/FeedTerminal";
import { fetchAlertFeed, fetchAlertSummary } from "@/lib/db/alerts";
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

  const channel = process.env.NEXT_PUBLIC_TELEGRAM_CHANNEL;
  const telegramUrl = channel ? `https://t.me/${channel.replace(/^@/, "")}` : null;

  return (
    <div className="flex min-h-screen flex-col bg-neutral-950 text-neutral-100">
      <div className="pointer-events-none fixed inset-0 overflow-hidden">
        <div className="absolute -top-40 left-1/2 h-[500px] w-[900px] -translate-x-1/2 rounded-full bg-blue-600/10 blur-3xl" />
      </div>

      <header className="relative border-b border-neutral-800/80 bg-neutral-950/80 backdrop-blur-sm">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-4 py-3 sm:px-6">
          <Link href="/" className="mr-auto flex items-center gap-3 rounded-lg transition-opacity hover:opacity-80">
            <span className="alpha-glow select-none text-2xl leading-none font-semibold text-white">
              α
            </span>
            <div>
              <div className="text-sm font-semibold leading-tight text-neutral-50">
                Alpha Wallet Finder
              </div>
              <div className="text-[11px] leading-tight text-neutral-500">Smart money feed</div>
            </div>
          </Link>
          {telegramUrl ? (
            <a
              href={telegramUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-blue-500"
            >
              Telegram
            </a>
          ) : null}
          <WalletConnectButton />
        </div>
      </header>

      <main className="relative mx-auto w-full max-w-6xl flex-1 px-3 py-4 sm:px-6 sm:py-6">
        {configured ? (
          <FeedTerminal initialAlerts={alerts} trackedWallets={summary?.trackedWallets ?? 0} />
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
