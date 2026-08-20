"use client";

import { useEffect } from "react";
import Link from "next/link";
import * as Sentry from "@sentry/nextjs";

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-neutral-950 px-4 text-center text-neutral-100">
      <span className="alpha-glow select-none text-4xl leading-none font-semibold text-white">α</span>
      <h1 className="mt-6 text-lg font-semibold">Something broke on our end</h1>
      <p className="mt-2 max-w-md text-sm text-neutral-400">
        The error has been reported. If you had just paid for a scan, your credit is safe — recover
        it below with your transaction signature.
      </p>
      {error.digest && (
        <p className="mt-2 font-mono text-[11px] text-neutral-600">ref {error.digest}</p>
      )}
      <div className="mt-6 flex flex-wrap items-center justify-center gap-2">
        <button
          onClick={reset}
          className="rounded-xl bg-gradient-to-b from-blue-500 to-blue-600 px-5 py-2.5 text-sm font-semibold text-white shadow-lg shadow-blue-600/25 transition-all hover:from-blue-400 hover:to-blue-500"
        >
          Try again
        </button>
        <Link
          href="/recover"
          className="rounded-xl border border-neutral-800 bg-neutral-900 px-5 py-2.5 text-sm font-medium text-neutral-200 transition-colors hover:border-neutral-700 hover:bg-neutral-800"
        >
          Recover a purchase
        </Link>
      </div>
    </div>
  );
}
