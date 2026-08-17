"use client";

import { useCallback, useEffect, useState } from "react";
import { TIER_OPTIONS, type TierInfo } from "@/lib/tiers";

/** Confirmation normally lands in a few seconds once the transaction is sent;
 * this is the outer bound before we offer a manual retry rather than leaving
 * the buyer staring at a spinner. */
const CONFIRM_TIMEOUT_MS = 3 * 60 * 1000;

/** Long enough to read "unlocked", short enough not to feel like a stall. */
const SUCCESS_HOLD_MS = 1400;

type PayMethod = "sol" | "usdc";

interface SolanaProvider {
  isPhantom?: boolean;
  publicKey?: { toString(): string } | null;
  connect(opts?: { onlyIfTrusted?: boolean }): Promise<{ publicKey: { toString(): string } }>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  signAndSendTransaction(transaction: any): Promise<{ signature: string }>;
}

function getProvider(): SolanaProvider | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { phantom?: { solana?: SolanaProvider }; solana?: SolanaProvider };
  return w.phantom?.solana ?? w.solana ?? null;
}

async function ensureBufferPolyfill() {
  const g = globalThis as unknown as { Buffer?: unknown };
  if (!g.Buffer) {
    const { Buffer } = await import("buffer");
    g.Buffer = Buffer;
  }
}

interface Quote {
  intentId: string;
  amount: number;
  method: PayMethod;
  transaction: string;
}

interface PaywallDialogProps {
  onClose: () => void;
  onPaid: (claimToken: string, tier: number) => void;
  /** Tier the user already picked in the search bar, preselected for them. */
  initialLimit?: number;
}

export default function PaywallDialog({ onClose, onPaid, initialLimit }: PaywallDialogProps) {
  const [tier, setTier] = useState<TierInfo | null>(
    () => TIER_OPTIONS.find((t) => t.limit === initialLimit) ?? null
  );
  const [status, setStatus] = useState<"idle" | "confirming" | "success" | "error">("idle");
  const [message, setMessage] = useState<string | null>(null);
  const [txId, setTxId] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [copied, setCopied] = useState(false);

  const [method, setMethod] = useState<PayMethod>("sol");
  const [walletPk, setWalletPk] = useState<string | null>(null);
  const [walletBusy, setWalletBusy] = useState(false);
  const [walletError, setWalletError] = useState<string | null>(null);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [sending, setSending] = useState(false);
  const [confirmingIntentId, setConfirmingIntentId] = useState<string | null>(null);

  // A secret only this browser knows, required to redeem the purchase. Without
  // it the public transaction signature would be enough for anyone watching
  // the treasury wallet to steal the buyer's scan.
  const [nonce] = useState(() => crypto.randomUUID());

  // Closing mid-confirmation would strand a paid credit, so it's blocked there.
  const locked = status === "confirming" || status === "success";
  const requestClose = useCallback(() => {
    if (!locked) onClose();
  }, [locked, onClose]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") requestClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [requestClose]);

  // Quotes the exact amount + unsigned transaction whenever the tier, method
  // or connected wallet changes, so "Pay" only ever has to sign and send.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!tier || !walletPk) {
        if (!cancelled) setQuote(null);
        return;
      }
      setQuoting(true);
      setQuote(null);
      setWalletError(null);
      try {
        const res = await fetch("/api/pay/init", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ tier: tier.limit, method, nonce, payer: walletPk }),
        });
        const data = await res.json();
        if (cancelled) return;
        if (!res.ok) {
          setWalletError(data?.error || "Could not prepare this payment.");
          return;
        }
        setQuote({ intentId: data.intentId, amount: data.amount, method: data.method, transaction: data.transaction });
      } catch {
        if (!cancelled) setWalletError("Could not reach the payment server.");
      } finally {
        if (!cancelled) setQuoting(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tier, walletPk, method, nonce]);

  // Confirmation is verified server-side directly against Solana (via Helius),
  // never trusted from the wallet's own success callback.
  const confirmPayment = useCallback(
    async (signature: string, intentId: string) => {
      setStatus("confirming");
      setMessage(null);
      setElapsed(0);
      setTxId(signature);

      const started = Date.now();
      while (Date.now() - started < CONFIRM_TIMEOUT_MS) {
        setElapsed(Math.round((Date.now() - started) / 1000));
        try {
          const query = new URLSearchParams({ intentId, nonce, signature });
          const res = await fetch(`/api/pay/confirm?${query.toString()}`);
          if (res.ok) {
            const data = await res.json();
            if (data.claimToken) {
              // Let the confirmation land visually before the scan takes over.
              setStatus("success");
              setTimeout(() => onPaid(data.claimToken, data.tier), SUCCESS_HOLD_MS);
              return;
            }
          } else if (res.status !== 202) {
            const data = await res.json().catch(() => null);
            setStatus("error");
            setMessage(data?.error || "That payment could not be confirmed.");
            return;
          }
        } catch {
          // keep retrying; transient network errors shouldn't end the flow
        }
        await new Promise((r) => setTimeout(r, 2000));
      }

      setStatus("error");
      setMessage(
        "Your payment may have gone through, but our confirmation is still catching up. Retry below — or send us the transaction id and we'll unlock it manually."
      );
    },
    [nonce, onPaid]
  );

  async function connectWallet() {
    setWalletError(null);
    const provider = getProvider();
    if (!provider) {
      window.open("https://phantom.app/download", "_blank", "noopener,noreferrer");
      setWalletError("No Solana wallet found. Install Phantom, then try again.");
      return;
    }
    setWalletBusy(true);
    try {
      const resp = await provider.connect();
      setWalletPk(resp.publicKey.toString());
    } catch {
      setWalletError("Wallet connection was cancelled.");
    } finally {
      setWalletBusy(false);
    }
  }

  async function pay() {
    if (!quote) return;
    const provider = getProvider();
    if (!provider) {
      setWalletError("No Solana wallet found. Install Phantom, then try again.");
      return;
    }
    setSending(true);
    setWalletError(null);
    setConfirmingIntentId(quote.intentId);
    try {
      await ensureBufferPolyfill();
      const { Transaction } = await import("@solana/web3.js");
      const tx = Transaction.from(Buffer.from(quote.transaction, "base64"));
      const { signature } = await provider.signAndSendTransaction(tx);
      void confirmPayment(signature, quote.intentId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "";
      setWalletError(
        msg.toLowerCase().includes("reject") || msg.toLowerCase().includes("cancel")
          ? "Payment was cancelled and you weren't charged."
          : "The payment didn't go through and you weren't charged. Try again."
      );
    } finally {
      setSending(false);
    }
  }

  async function copyTx() {
    if (!txId) return;
    await navigator.clipboard.writeText(txId);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-black/85 p-4 backdrop-blur-md animate-fade-in"
      onClick={requestClose}
      role="dialog"
      aria-modal="true"
      aria-label="Unlock a scan"
    >
      <div
        className="flex max-h-[92vh] w-full max-w-md flex-col overflow-hidden rounded-2xl border border-neutral-800 bg-neutral-950 shadow-[0_0_60px_-15px_rgba(59,130,246,0.35)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="border-b border-neutral-800/80 bg-gradient-to-b from-neutral-900 to-neutral-950 px-6 py-5">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h3 className="text-base font-semibold tracking-tight text-neutral-50">
                {status === "confirming" ? "Confirming payment" : tier ? tier.label : "Unlock this scan"}
              </h3>
              <p className="mt-0.5 text-xs text-neutral-500">
                {status === "confirming"
                  ? "Hang tight — don't close this window"
                  : "One payment, one full scan. No subscription."}
              </p>
            </div>
            {!locked && (
              <button
                onClick={onClose}
                className="-mr-1 -mt-1 rounded-lg p-1.5 text-neutral-500 transition-colors hover:bg-neutral-800 hover:text-neutral-200"
                aria-label="Close"
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M18 6L6 18M6 6l12 12" />
                </svg>
              </button>
            )}
          </div>
        </div>

        <div className="overflow-y-auto px-6 py-5">
          {status === "confirming" && <Confirming elapsed={elapsed} />}

          {status === "success" && <PaymentSuccess tier={tier?.limit ?? null} />}

          {status === "error" && (
            <div className="space-y-4 py-2">
              <div className="rounded-xl border border-amber-900/50 bg-amber-950/25 px-4 py-3.5">
                <p className="text-sm leading-relaxed text-amber-200">{message}</p>
              </div>

              {txId && (
                <div className="rounded-xl border border-neutral-800 bg-neutral-900/50 p-3.5">
                  <div className="mb-2 text-[11px] font-medium uppercase tracking-wide text-neutral-500">
                    Transaction id
                  </div>
                  <div className="flex items-center gap-2">
                    <code className="min-w-0 flex-1 truncate rounded-lg bg-neutral-950 px-2.5 py-2 font-mono text-[11px] text-neutral-300">
                      {txId}
                    </code>
                    <button
                      onClick={copyTx}
                      className="shrink-0 rounded-lg border border-neutral-700 px-2.5 py-2 text-[11px] font-medium text-neutral-300 transition-colors hover:border-neutral-600 hover:text-neutral-100"
                    >
                      {copied ? "Copied" : "Copy"}
                    </button>
                  </div>
                </div>
              )}

              <div className="flex gap-2">
                <button
                  onClick={() => txId && confirmingIntentId && void confirmPayment(txId, confirmingIntentId)}
                  disabled={!txId || !confirmingIntentId}
                  className="flex-1 rounded-xl bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-500 disabled:opacity-50"
                >
                  Retry confirmation
                </button>
                <a
                  href="https://x.com/crypce0"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="rounded-xl border border-neutral-700 px-4 py-2.5 text-sm font-medium text-neutral-300 transition-colors hover:border-neutral-600 hover:text-neutral-100"
                >
                  Get help
                </a>
              </div>
            </div>
          )}

          {status === "idle" && !tier && (
            <div className="space-y-2.5">
              {TIER_OPTIONS.map((t) => (
                <button
                  key={t.limit}
                  onClick={() => setTier(t)}
                  className="group flex w-full items-center justify-between gap-4 rounded-xl border border-neutral-800 bg-neutral-900/40 px-4 py-3.5 text-left transition-all hover:border-blue-500/50 hover:bg-neutral-900"
                >
                  <div className="min-w-0">
                    <div className="text-sm font-semibold text-neutral-100">{t.label}</div>
                    <div className="mt-0.5 text-[11px] text-neutral-500">
                      Full PNL, entry &amp; exit, CSV export
                    </div>
                  </div>
                  <div className="shrink-0 text-right">
                    <div className="text-lg font-semibold text-neutral-50">{t.price}</div>
                    <div className="text-[10px] text-neutral-600 transition-colors group-hover:text-blue-400">
                      Select →
                    </div>
                  </div>
                </button>
              ))}
              <p className="pt-1 text-center text-[11px] leading-relaxed text-neutral-600">
                Pay with SOL or USDC, straight to our wallet. No middleman.
              </p>
            </div>
          )}

          {status === "idle" && tier && (
            <div className="space-y-3">
              <div className="flex items-center justify-between rounded-xl border border-neutral-800 bg-neutral-900/40 px-4 py-3">
                <div>
                  <div className="text-sm font-medium text-neutral-100">{tier.label}</div>
                  <div className="text-[11px] text-neutral-500">{tier.limit} wallets</div>
                </div>
                <div className="flex items-center gap-3">
                  <div className="text-right">
                    <span className="text-base font-semibold text-neutral-50">{tier.price}</span>
                    {walletPk && quote && (
                      <div className="text-[11px] text-neutral-500">≈ {formatAmount(quote.amount, quote.method)}</div>
                    )}
                  </div>
                  <button
                    onClick={() => setTier(null)}
                    className="text-[11px] text-neutral-500 underline underline-offset-2 transition-colors hover:text-neutral-300"
                  >
                    Change
                  </button>
                </div>
              </div>

              <div className="flex overflow-hidden rounded-xl border border-neutral-800">
                {((["sol", "usdc"] as const)).map((m) => (
                  <button
                    key={m}
                    onClick={() => setMethod(m)}
                    className={`flex-1 py-2.5 text-sm font-semibold transition-colors ${
                      method === m
                        ? "bg-blue-600 text-white"
                        : "bg-neutral-900/40 text-neutral-400 hover:text-neutral-200"
                    }`}
                  >
                    {m === "sol" ? "Pay with SOL" : "Pay with USDC"}
                  </button>
                ))}
              </div>

              {!walletPk ? (
                <button
                  onClick={() => void connectWallet()}
                  disabled={walletBusy}
                  className="w-full rounded-xl bg-neutral-100 px-4 py-3 text-sm font-semibold text-neutral-950 transition-colors hover:bg-white disabled:opacity-60"
                >
                  {walletBusy ? "Connecting…" : "Connect wallet"}
                </button>
              ) : (
                <div className="space-y-2.5">
                  <div className="flex items-center justify-between rounded-xl border border-neutral-800 bg-neutral-900/30 px-3.5 py-2.5 text-[11px] text-neutral-500">
                    <span>Connected</span>
                    <code className="font-mono text-neutral-300">
                      {walletPk.slice(0, 4)}…{walletPk.slice(-4)}
                    </code>
                  </div>
                  <button
                    onClick={() => void pay()}
                    disabled={!quote || quoting || sending}
                    className="w-full rounded-xl bg-blue-600 px-4 py-3 text-sm font-semibold text-white transition-colors hover:bg-blue-500 disabled:opacity-60"
                  >
                    {sending
                      ? "Confirm in wallet…"
                      : quoting || !quote
                      ? "Preparing…"
                      : `Pay ${tier.price} · ${formatAmount(quote.amount, quote.method)}`}
                  </button>
                </div>
              )}

              {walletError && <p className="text-center text-[11px] text-amber-400">{walletError}</p>}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function formatAmount(amount: number, method: PayMethod): string {
  if (method === "sol") return `${(amount / 1e9).toFixed(4)} SOL`;
  return `${(amount / 1e6).toFixed(2)} USDC`;
}

function PaymentSuccess({ tier }: { tier: number | null }) {
  return (
    <div className="flex flex-col items-center gap-4 py-12 text-center">
      <div className="relative flex h-16 w-16 items-center justify-center">
        <span className="absolute inset-0 animate-success-ring rounded-full bg-emerald-500/20" />
        <span className="absolute inset-0 rounded-full border-2 border-emerald-500/40" />
        <svg
          className="relative h-8 w-8 text-emerald-400"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path className="animate-success-check" d="M20 6L9 17l-5-5" pathLength={1} />
        </svg>
      </div>
      <div className="animate-fade-in">
        <p className="text-sm font-semibold text-emerald-300">Payment confirmed</p>
        <p className="mt-1 text-xs text-neutral-400">
          {tier ? `Top ${tier} unlocked — starting your scan…` : "Starting your scan…"}
        </p>
      </div>
    </div>
  );
}

function Confirming({ elapsed }: { elapsed: number }) {
  const slow = elapsed > 20;
  return (
    <div className="flex flex-col items-center gap-3 py-12 text-center">
      <div className="relative h-12 w-12">
        <div className="absolute inset-0 rounded-full border-2 border-neutral-800" />
        <div className="absolute inset-0 animate-spin rounded-full border-2 border-transparent border-t-blue-500" />
      </div>
      <div>
        <p className="text-sm font-medium text-neutral-200">
          {slow ? "Still confirming…" : "Confirming your payment"}
        </p>
        <p className="mt-1 text-xs text-neutral-500">
          {slow
            ? "The network is busy. Your payment is safe — keep this open."
            : "Usually done in a few seconds."}
        </p>
      </div>
      <div className="mt-1 text-[11px] tabular-nums text-neutral-600">{elapsed}s</div>
    </div>
  );
}
