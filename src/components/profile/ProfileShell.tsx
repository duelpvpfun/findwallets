import Link from "next/link";
import WalletConnectButton from "@/components/WalletConnectButton";

/** Header/footer chrome for /profile, matching the main page's identity. */
export default function ProfileShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col bg-neutral-950 text-neutral-100">
      <div className="pointer-events-none fixed inset-0 overflow-hidden">
        <div className="absolute -top-40 left-1/2 h-[500px] w-[900px] -translate-x-1/2 rounded-full bg-blue-600/10 blur-3xl" />
      </div>

      <header className="relative border-b border-neutral-800/80 bg-neutral-950/80 backdrop-blur-sm">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-3 px-4 py-3 sm:px-6 sm:py-4">
          <Link href="/" className="flex items-center gap-3 rounded-lg transition-opacity hover:opacity-80">
            <span className="alpha-glow select-none text-2xl leading-none font-semibold text-white">
              α
            </span>
            <div>
              <div className="text-sm font-semibold leading-tight text-neutral-50">
                Alpha Wallet Finder
              </div>
              <div className="text-[11px] leading-tight text-neutral-500">Your account</div>
            </div>
          </Link>
          <WalletConnectButton />
        </div>
      </header>

      <main className="relative mx-auto w-full max-w-5xl flex-1 px-4 py-6 sm:px-6 sm:py-10">
        {children}
      </main>

      <footer className="relative mt-auto border-t border-neutral-800/80 bg-neutral-950/80">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-3 px-4 py-4 sm:px-6">
          <Link href="/" className="text-xs font-medium text-neutral-400 transition-colors hover:text-neutral-100">
            ← Back to scanning
          </Link>
          <a
            href="https://x.com/crypce0"
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-neutral-500 transition-colors hover:text-neutral-300"
          >
            Need help? @crypce0
          </a>
        </div>
      </footer>
    </div>
  );
}
