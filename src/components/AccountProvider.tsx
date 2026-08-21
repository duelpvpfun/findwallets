"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { buildSignInMessage } from "@/lib/auth/message";
import { normalizeWallet, type WalletFamily } from "@/lib/auth/wallet";
import { encodeSignature, getProvider, openWalletInstall, walletErrorMessage } from "@/lib/phantom";
import { connectEvm, EVM_INSTALL_URL, getEvmProvider, signEvmMessage } from "@/lib/evmWallet";

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
 *
 * Both wallet families can hold an account. Solana signs with `signMessage` and
 * Ed25519; EVM signs with `personal_sign` and is verified by secp256k1 recovery.
 * Neither costs the user anything, and neither is a transaction.
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
  /** Omit the family to use whichever wallet is installed. */
  signIn: (family?: WalletFamily) => Promise<boolean>;
  /** Which wallet families are injected right now, read at call time because
   * extensions inject late. */
  detectWallets: () => WalletFamily[];
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

  const detectWallets = useCallback((): WalletFamily[] => {
    const found: WalletFamily[] = [];
    if (getProvider()) found.push("solana");
    if (getEvmProvider()) found.push("evm");
    return found;
  }, []);

  const signIn = useCallback(
    async (family?: WalletFamily): Promise<boolean> => {
      setError(null);
      const available = detectWallets();
      const target = family ?? available[0];

      if (!target) {
        openWalletInstall();
        setError("No wallet found. Install Phantom or MetaMask, then try again.");
        return false;
      }
      // Held in locals rather than re-fetched later, so the rest of this
      // function needs no assertion that the provider is still there.
      const solanaProvider = target === "solana" ? getProvider() : null;
      const evmProvider = target === "evm" ? getEvmProvider() : null;
      if (!solanaProvider && !evmProvider) {
        if (target === "evm") window.open(EVM_INSTALL_URL, "_blank", "noopener,noreferrer");
        else openWalletInstall();
        setError(
          target === "evm"
            ? "No EVM wallet found. Install MetaMask, then try again."
            : "No Solana wallet found. Install Phantom, then try again."
        );
        return false;
      }

      setBusy(true);
      try {
        // Connect, then normalize. The normalized address is what goes into the
        // signed message, because that is what the server rebuilds it from: an
        // EVM wallet that reports a checksummed address would otherwise sign a
        // different string than the one being verified.
        const reported = solanaProvider
          ? (await solanaProvider.connect()).publicKey.toString()
          : evmProvider
          ? await connectEvm(evmProvider)
          : null;
        const wallet = reported ? normalizeWallet(reported) : null;
        if (!wallet) {
          setError("That wallet did not return a usable address.");
          return false;
        }

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
        // contain. A message-signing call in both cases, never a transaction:
        // this costs the user nothing on either chain.
        const message = buildSignInMessage(wallet, nonceData.nonce);
        let signature: string | null = null;
        if (solanaProvider) {
          const signed = await solanaProvider.signMessage(
            new TextEncoder().encode(message),
            "utf8"
          );
          signature = await encodeSignature(signed.signature);
        } else if (evmProvider) {
          signature = await signEvmMessage(evmProvider, wallet, message);
        }
        if (!signature) {
          setError("That wallet did not return a signature.");
          return false;
        }

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
          walletErrorMessage(
            err,
            "Sign-in was cancelled. Nothing was signed and nothing was spent."
          ) ?? "Sign-in failed. Try again."
        );
        return false;
      } finally {
        setBusy(false);
      }
    },
    [detectWallets, refresh]
  );

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
      detectWallets,
      signOut,
      refresh,
      clearError: () => setError(null),
    }),
    [user, balance, loading, busy, error, signIn, detectWallets, signOut, refresh]
  );

  return <AccountContext.Provider value={value}>{children}</AccountContext.Provider>;
}
