"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { buildSignInMessage } from "@/lib/auth/message";
import { encodeSignature, getProvider, openWalletInstall, walletErrorMessage } from "@/lib/phantom";

/**
 * The signed-in account, shared by the header, the paywall and the profile.
 *
 * Entitlement used to live only in a localStorage claim token, so a buyer who
 * cleared their browser, switched device or hit an error lost a paid credit
 * permanently. Signing in with the wallet they paid from attaches every past
 * purchase retroactively — `scan_credits.payer_wallet` has been recorded on
 * every confirmed payment since launch.
 *
 * Signing in is never required. Everything here is additive: with no session the
 * app behaves exactly as it did before accounts existed.
 */

export interface CreditBalance {
  byTier: Array<{ tier: number; count: number }>;
  total: number;
  bestTier: number | null;
  pending: number;
}

interface AccountState {
  /** Null while loading and when signed out — check `loading` to tell them apart. */
  user: { wallet: string } | null;
  balance: CreditBalance | null;
  loading: boolean;
  /** A wallet prompt is open, or verification is in flight. */
  busy: boolean;
  error: string | null;
  signIn: () => Promise<boolean>;
  signOut: () => Promise<void>;
  refresh: () => Promise<void>;
  clearError: () => void;
}

const AccountContext = createContext<AccountState | null>(null);

export function useAccount(): AccountState {
  const ctx = useContext(AccountContext);
  if (!ctx) throw new Error("useAccount must be used inside <AccountProvider>");
  return ctx;
}

interface SessionSnapshot {
  user: { wallet: string } | null;
  balance: CreditBalance | null;
}

/**
 * Reads the session. The cookie is `httpOnly`, so the browser cannot inspect it
 * — asking the server is how the client finds out who it is, and it is also
 * where the sliding 30-day expiry slides.
 *
 * Deliberately holds no state: a failure resolves to "signed out" rather than
 * throwing. Nothing in the app requires an account, so the worst case of a
 * transient error is a header that says "Connect" until the next load.
 */
async function loadSession(): Promise<SessionSnapshot> {
  try {
    const res = await fetch("/api/auth/me", { cache: "no-store" });
    if (!res.ok) return { user: null, balance: null };
    const data = await res.json();
    return { user: data.user ?? null, balance: data.balance ?? null };
  } catch {
    return { user: null, balance: null };
  }
}

export default function AccountProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<{ wallet: string } | null>(null);
  const [balance, setBalance] = useState<CreditBalance | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const snapshot = await loadSession();
    setUser(snapshot.user);
    setBalance(snapshot.balance);
    setLoading(false);
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const snapshot = await loadSession();
      if (cancelled) return;
      setUser(snapshot.user);
      setBalance(snapshot.balance);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const signIn = useCallback(async (): Promise<boolean> => {
    setError(null);
    const provider = getProvider();
    if (!provider) {
      openWalletInstall();
      setError("No Solana wallet found. Install Phantom, then try again.");
      return false;
    }

    setBusy(true);
    try {
      const connected = await provider.connect();
      const wallet = connected.publicKey.toString();

      const nonceRes = await fetch("/api/auth/nonce", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ wallet }),
      });
      const nonceData = await nonceRes.json();
      if (!nonceRes.ok) {
        setError(nonceData?.error ?? "Could not start sign-in.");
        return false;
      }

      // Rebuilt locally from the same shared function the server verifies
      // against, rather than signing whatever text the response happened to
      // contain. `signMessage`, never `signAndSendTransaction`: this is a
      // signature, and it costs zero lamports.
      const message = buildSignInMessage(wallet, nonceData.nonce);
      const signed = await provider.signMessage(new TextEncoder().encode(message), "utf8");
      const signature = await encodeSignature(signed.signature);

      const verifyRes = await fetch("/api/auth/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ wallet, nonce: nonceData.nonce, signature }),
      });
      const verifyData = await verifyRes.json();
      if (!verifyRes.ok) {
        setError(verifyData?.error ?? "Sign-in could not be verified.");
        return false;
      }

      await refresh();
      return true;
    } catch (err) {
      setError(
        walletErrorMessage(err, "Sign-in was cancelled. Nothing was signed and nothing was spent.") ??
          "Sign-in failed. Try again."
      );
      return false;
    } finally {
      setBusy(false);
    }
  }, [refresh]);

  const signOut = useCallback(async () => {
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } catch {
      // The cookie may survive a failed request; the next /me call corrects it.
    }
    setUser(null);
    setBalance(null);
  }, []);

  const value = useMemo<AccountState>(
    () => ({
      user,
      balance,
      loading,
      busy,
      error,
      signIn,
      signOut,
      refresh,
      clearError: () => setError(null),
    }),
    [user, balance, loading, busy, error, signIn, signOut, refresh]
  );

  return <AccountContext.Provider value={value}>{children}</AccountContext.Provider>;
}
