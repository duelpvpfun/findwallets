import Link from "next/link";

export default function NotFound() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-neutral-950 px-4 text-center text-neutral-100">
      <span className="alpha-glow select-none text-4xl leading-none font-semibold text-white">α</span>
      <h1 className="mt-6 text-lg font-semibold">Page not found</h1>
      <p className="mt-2 max-w-md text-sm text-neutral-400">
        That link doesn&apos;t point anywhere on Alpha Wallet Finder.
      </p>
      <Link
        href="/"
        className="mt-6 rounded-xl bg-gradient-to-b from-blue-500 to-blue-600 px-5 py-2.5 text-sm font-semibold text-white shadow-lg shadow-blue-600/25 transition-all hover:from-blue-400 hover:to-blue-500"
      >
        Back to search
      </Link>
    </div>
  );
}
