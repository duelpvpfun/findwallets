"use client";

import { useEffect, useState } from "react";
import dynamic from "next/dynamic";
import { TIER_OPTIONS, type TierInfo } from "@/lib/tiers";

// Helio's widget touches browser globals, so keep it out of the server bundle.
const HelioCheckout = dynamic(
  () => import("@heliofi/checkout-react").then((m) => m.HelioCheckout),
  { ssr: false, loading: () => <WidgetSkeleton /> }
);

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
  const [status, setStatus] = useState<"idle" | "confirming" | "error">("idle");
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // The widget's success callback can't be trusted on its own, so we poll our
  // own API until Helio's server-to-server webhook has confirmed the payment.
  async function confirmPayment(paymentId: string) {
    setStatus("confirming");
    setMessage(null);
    for (let attempt = 0; attempt < 20; attempt++) {
      try {
        const res = await fetch(`/api/claim?paymentId=${encodeURIComponent(paymentId)}`);
        if (res.ok) {
          const data = await res.json();
          if (data.claimToken) {
            onPaid(data.claimToken, data.tier);
            return;
          }
        }
      } catch {
        // keep retrying; transient network errors shouldn't end the flow
      }
      await new Promise((r) => setTimeout(r, 1500));
    }
    setStatus("error");
    setMessage(
      "Payment received but confirmation is taking longer than usual. Keep this page open or contact support with your transaction id."
    );
  }

  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm animate-fade-in"
      onClick={onClose}
    >
      <div
        className="flex max-h-[90vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-neutral-800 bg-neutral-950 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between border-b border-neutral-800 px-5 py-4">
          <div>
            <h3 className="text-sm font-semibold text-neutral-50">
              {tier ? `Pay for ${tier.label}` : "Choose how many wallets"}
            </h3>
            <p className="text-[11px] text-neutral-500">One payment unlocks one scan</p>
          </div>
          <button
            onClick={onClose}
            className="rounded-lg p-1.5 text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200"
            aria-label="Close"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="overflow-y-auto px-5 py-5">
          {status === "confirming" && (
            <div className="flex flex-col items-center gap-3 py-10 text-center">
              <svg className="h-6 w-6 animate-spin text-blue-400" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
                <path className="opacity-90" fill="currentColor" d="M4 12a8 8 0 018-8v3a5 5 0 00-5 5H4z" />
              </svg>
              <p className="text-sm text-neutral-300">Confirming your payment…</p>
              <p className="text-xs text-neutral-500">This usually takes a few seconds.</p>
            </div>
          )}

          {status === "error" && (
            <div className="rounded-xl border border-amber-900/60 bg-amber-950/30 px-4 py-3 text-sm text-amber-300">
              {message}
            </div>
          )}

          {status === "idle" && !tier && (
            <div className="grid grid-cols-2 gap-3">
              {TIER_OPTIONS.map((t) => (
                <button
                  key={t.limit}
                  onClick={() => setTier(t)}
                  className="rounded-xl border border-neutral-800 bg-neutral-900/60 p-4 text-left transition-colors hover:border-blue-500/60 hover:bg-neutral-900"
                >
                  <div className="text-lg font-semibold text-neutral-50">{t.price}</div>
                  <div className="mt-0.5 text-xs font-medium text-neutral-300">{t.label}</div>
                  <div className="mt-2 text-[11px] text-neutral-500">
                    {t.limit} wallets · full PNL, entry/exit &amp; export
                  </div>
                </button>
              ))}
            </div>
          )}

          {status === "idle" && tier && (
            <div>
              <button
                onClick={() => setTier(null)}
                className="mb-3 text-xs text-neutral-500 underline hover:text-neutral-300"
              >
                ← Choose a different size
              </button>
              <HelioCheckout
                config={{
                  paylinkId: tier.paylinkId,
                  theme: { themeMode: "dark" },
                  primaryColor: "#6400CC",
                  neutralColor: "#5A6578",
                  display: "inline",
                  onSuccess: (event: Record<string, unknown>) => {
                    const paymentId =
                      (event?.transaction as string) ||
                      (event?.id as string) ||
                      ((event?.data as Record<string, unknown>)?.id as string);
                    if (paymentId) confirmPayment(paymentId);
                    else {
                      setStatus("error");
                      setMessage("Payment succeeded but no transaction id was returned.");
                    }
                  },
                  onError: () => {
                    setStatus("error");
                    setMessage("Payment failed. No charge was made.");
                  },
                  onCancel: () => setTier(null),
                }}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function WidgetSkeleton() {
  return <div className="h-64 animate-pulse rounded-xl border border-neutral-800 bg-neutral-900/50" />;
}
