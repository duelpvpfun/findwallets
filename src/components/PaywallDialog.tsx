"use client";

import { useCallback, useEffect, useState } from "react";
import dynamic from "next/dynamic";
import { TIER_OPTIONS, type TierInfo } from "@/lib/tiers";

// Helio's widget touches browser globals, so keep it out of the server bundle.
const HelioCheckout = dynamic(
  () => import("@heliofi/checkout-react").then((m) => m.HelioCheckout),
  { ssr: false, loading: () => <WidgetSkeleton /> }
);

/** Webhooks normally land in seconds; this is the outer bound before we offer
 * a manual retry rather than leaving the buyer staring at a spinner. */
const CONFIRM_TIMEOUT_MS = 3 * 60 * 1000;

/** Long enough to read "unlocked", short enough not to feel like a stall. */
const SUCCESS_HOLD_MS = 1400;

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

  // A secret only this browser knows, sent through Helio and required to redeem
  // the purchase. Without it the public transaction signature would be enough
  // for anyone watching the merchant wallet to steal the buyer's scan.
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

  // The widget's success callback can't be trusted on its own, so we poll our
  // own API until Helio's server-to-server webhook has confirmed the payment.
  // The nonce alone is enough to resolve the credit; the payment id is passed
  // when Helio gives us one, purely as a fallback lookup.
  const confirmPayment = useCallback(
    async (paymentId: string | null) => {
      setStatus("confirming");
      setMessage(null);
      setElapsed(0);
      if (paymentId) setTxId(paymentId);

      const started = Date.now();
      while (Date.now() - started < CONFIRM_TIMEOUT_MS) {
        setElapsed(Math.round((Date.now() - started) / 1000));
        try {
          const query = new URLSearchParams({ nonce });
          if (paymentId) query.set("paymentId", paymentId);
          const res = await fetch(`/api/claim?${query.toString()}`);
          if (res.ok) {
            const data = await res.json();
            if (data.claimToken) {
              // Let the confirmation land visually before the scan takes over.
              setStatus("success");
              setTimeout(() => onPaid(data.claimToken, data.tier), SUCCESS_HOLD_MS);
              return;
            }
          }
        } catch {
          // keep retrying; transient network errors shouldn't end the flow
        }
        await new Promise((r) => setTimeout(r, 2000));
      }

      setStatus("error");
      setMessage(
        "Your payment went through, but our confirmation is still catching up. Retry below — or send us the transaction id and we'll unlock it manually."
      );
    },
    [nonce, onPaid]
  );

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
                  onClick={() => void confirmPayment(txId)}
                  className="flex-1 rounded-xl bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-500"
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
                Pay with SOL, USDC or card. Powered by Helio.
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
                  <span className="text-base font-semibold text-neutral-50">{tier.price}</span>
                  <button
                    onClick={() => setTier(null)}
                    className="text-[11px] text-neutral-500 underline underline-offset-2 transition-colors hover:text-neutral-300"
                  >
                    Change
                  </button>
                </div>
              </div>

              <div className="overflow-hidden rounded-xl">
                <HelioCheckout
                  config={{
                    paylinkId: tier.paylinkId,
                    theme: { themeMode: "dark" },
                    primaryColor: "#2563EB",
                    neutralColor: "#404040",
                    display: "inline",
                    stretchFullWidth: true,
                    additionalJSON: { nonce },
                    onSuccess: (event) => {
                      const data = event?.data as Record<string, unknown> | undefined;
                      const paymentId =
                        event?.transaction ||
                        (data?.id as string) ||
                        (data?.transactionSignature as string) ||
                        null;
                      // A missing id is fine: the nonce resolves the credit on its own.
                      void confirmPayment(paymentId);
                    },
                    onPending: (event) => void confirmPayment(event?.transaction ?? null),
                    onError: (event) => {
                      setStatus("error");
                      setMessage(
                        event?.errorMessage ||
                          "The payment didn't go through and you weren't charged. Try again."
                      );
                    },
                    onCancel: () => setTier(null),
                  }}
                />
              </div>

              <WalletWarningNote />
            </div>
          )}
        </div>
      </div>
    </div>
  );
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

/** Unverified dapps trip wallet phishing heuristics, so say so before the
 * warning appears rather than letting it read as a scam signal. */
function WalletWarningNote() {
  return (
    <div className="flex gap-2.5 rounded-xl border border-neutral-800/70 bg-neutral-900/30 px-3.5 py-3">
      <svg
        className="mt-0.5 h-3.5 w-3.5 shrink-0 text-neutral-500"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
      >
        <circle cx="12" cy="12" r="10" />
        <path d="M12 16v-4M12 8h.01" />
      </svg>
      <p className="text-[11px] leading-relaxed text-neutral-500">
        Your wallet may flag this as an unrecognised site — that&apos;s a default warning for any
        domain not yet on its allowlist, not a detected threat. The transaction is a plain transfer
        to Helio, our payment processor. Check the amount before approving; we never request token
        approvals or wallet permissions.
      </p>
    </div>
  );
}

function WidgetSkeleton() {
  return <div className="h-64 animate-pulse rounded-xl border border-neutral-800 bg-neutral-900/50" />;
}
