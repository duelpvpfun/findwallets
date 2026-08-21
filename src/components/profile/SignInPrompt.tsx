"use client";

import Link from "next/link";
import { useAccount } from "@/components/AccountProvider";
import ProfileShell from "./ProfileShell";

/**
 * What an unauthenticated visitor sees at /profile.
 *
 * The pitch is the retroactive backfill: a buyer who has been redeeming by claim
 * token gets their whole history the moment they sign in, because the payer
 * wallet was recorded on every confirmed payment.
 */
export default function SignInPrompt({ configured }: { configured: boolean }) {
  const { signIn, busy, error } = useAccount();

  return (
    <ProfileShell>
      <div className="mx-auto max-w-lg rounded-2xl border border-neutral-800 bg-neutral-900/40 p-6 text-center sm:p-8">
        <h1 className="text-lg font-semibold tracking-tight text-neutral-50">
          Connect your wallet
        </h1>
        <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-neutral-400">
          Your purchases are attached to the wallet you paid from. Connect it and
          every scan you have ever bought shows up here, including ones from
          before accounts existed.
        </p>

        <ul className="mx-auto mt-5 max-w-sm space-y-2 text-left text-[13px] text-neutral-400">
          <Bullet>Credits follow the account, not the browser.</Bullet>
          <Bullet>Re-download any result from the last 7 days, free.</Bullet>
          <Bullet>Signing is free. A message, never a transaction.</Bullet>
        </ul>

        {configured ? (
          <button
            onClick={() => void signIn()}
            disabled={busy}
            className="mt-6 w-full rounded-xl bg-neutral-100 px-4 py-3 text-sm font-semibold text-neutral-950 transition-colors hover:bg-white disabled:opacity-60 sm:w-auto sm:px-8"
          >
            {busy ? "Check your wallet…" : "Connect wallet"}
          </button>
        ) : (
          <p className="mt-6 rounded-xl border border-amber-900/50 bg-amber-950/25 px-4 py-3 text-xs text-amber-200">
            Accounts aren&apos;t available on this deployment.
          </p>
        )}

        {error && <p className="mt-3 text-xs text-amber-400">{error}</p>}

        <p className="mt-5 text-[11px] text-neutral-500">
          Lost a purchase and don&apos;t want to connect?{" "}
          <Link href="/recover" className="text-neutral-300 underline underline-offset-2 hover:text-neutral-100">
            Recover it with your transaction id
          </Link>
          .
        </p>
      </div>
    </ProfileShell>
  );
}

function Bullet({ children }: { children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-2">
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="mt-0.5 shrink-0 text-emerald-400"
      >
        <path d="M20 6 9 17l-5-5" />
      </svg>
      {children}
    </li>
  );
}
