"use client";

import Link from "next/link";
import { useAccount } from "@/components/AccountProvider";
import { WALLET_FAMILY_LABELS, type WalletFamily } from "@/lib/auth/wallet";
import ProfileShell from "./ProfileShell";

/**
 * What an unauthenticated visitor sees at /profile.
 *
 * The pitch is the retroactive backfill: a buyer who has been redeeming by claim
 * token gets their whole history the moment they sign in, because the payer
 * wallet was recorded on every confirmed payment.
 */
const FAMILIES: WalletFamily[] = ["solana", "evm"];

export default function SignInPrompt({ configured }: { configured: boolean }) {
  const { signIn, busy, error } = useAccount();

  return (
    <ProfileShell>
      <div className="mx-auto max-w-lg rounded-2xl border border-neutral-800 bg-neutral-900/40 p-6 text-center sm:p-8">
        <h1 className="text-lg font-semibold tracking-tight text-neutral-50">
          Connect your wallet
        </h1>
        <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-neutral-400">
          Solana or EVM, either works. Your purchases are attached to the
          wallet you paid from, so connecting it shows every scan you have ever
          bought, including ones from before accounts existed.
        </p>

        <ul className="mx-auto mt-5 max-w-sm space-y-2 text-left text-[13px] text-neutral-400">
          <Bullet>Credits follow the account.</Bullet>
          <Bullet>Re-download any result from the last 7 days, free.</Bullet>
          <Bullet>Signing is free. A message, never a transaction.</Bullet>
        </ul>

        {configured ? (
          // Both offered outright rather than detected. This is the page whose
          // whole job is to explain that an account exists, so saying which
          // wallets can hold one is the point; signIn() sends anyone without
          // that wallet to its install page.
          <div className="mt-6 flex flex-col items-center justify-center gap-2 sm:flex-row">
            {FAMILIES.map((family, i) => (
              <button
                key={family}
                onClick={() => void signIn(family)}
                disabled={busy}
                className={`w-full rounded-xl px-4 py-3 text-sm font-semibold transition-colors disabled:opacity-60 sm:w-auto sm:px-7 ${
                  i === 0
                    ? "bg-neutral-100 text-neutral-950 hover:bg-white"
                    : "border border-neutral-700 text-neutral-100 hover:border-neutral-600 hover:bg-neutral-800"
                }`}
              >
                {busy ? "Check your wallet…" : `Connect ${WALLET_FAMILY_LABELS[family]}`}
              </button>
            ))}
          </div>
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
