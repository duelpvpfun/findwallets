"use client";

import { useEffect, useRef, useState } from "react";
import type { TokenMeta, WalletTrader } from "@/lib/types";
import { CARD_HEIGHT, CARD_WIDTH, drawPnlCard } from "@/lib/shareCard";
import { shortenAddress } from "@/lib/format";

interface ShareCardModalProps {
  token: TokenMeta;
  trader: WalletTrader;
  onClose: () => void;
}

export default function ShareCardModal({ token, trader, onClose }: ShareCardModalProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [canCopyImage] = useState(
    () => typeof window !== "undefined" && "ClipboardItem" in window && Boolean(navigator.clipboard?.write)
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    setReady(false);
    setError(null);

    // Realized + unrealized combined, so a wallet still holding its bag isn't
    // shown as if it only made the money it has already cashed out.
    const totalPnlUsd = trader.realizedPnlUsd + (trader.unrealizedPnlUsd ?? 0);
    const investedUsd = trader.boughtUsd;
    const positionUsd = investedUsd + totalPnlUsd;

    drawPnlCard(canvas, {
      symbol: token.symbol,
      walletAddress: trader.address,
      pnlUsd: totalPnlUsd,
      pnlPercent: investedUsd > 0 ? (totalPnlUsd / investedUsd) * 100 : trader.realizedPnlPercent,
      multipleX: investedUsd > 0 ? positionUsd / investedUsd : trader.avgMultipleX ?? 0,
      investedUsd,
      positionUsd,
      siteHost: window.location.host,
    })
      .then(() => setReady(true))
      .catch(() => setError("Could not render the card."));
  }, [token, trader]);

  function download() {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.toBlob((blob) => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${token.symbol}-${shortenAddress(trader.address, 4)}-pnl.png`;
      a.click();
      URL.revokeObjectURL(url);
    }, "image/png");
  }

  function copyImage() {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.toBlob(async (blob) => {
      if (!blob) return;
      try {
        await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      } catch {
        setError("Could not copy the image. Try downloading instead.");
      }
    }, "image/png");
  }

  return (
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm animate-fade-in"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Share PNL card"
    >
      <div
        className="flex w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-neutral-800 bg-neutral-950 shadow-2xl shadow-black/50"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-neutral-800 px-5 py-3.5">
          <h3 className="text-sm font-semibold text-neutral-100">Share PNL card</h3>
          <button
            onClick={onClose}
            className="-mr-1 rounded-lg p-1.5 text-neutral-500 transition-colors hover:bg-neutral-800 hover:text-neutral-200"
            aria-label="Close"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="p-5">
          <div
            className="w-full overflow-hidden rounded-xl border border-neutral-800 bg-neutral-900"
            style={{ aspectRatio: `${CARD_WIDTH} / ${CARD_HEIGHT}` }}
          >
            <canvas ref={canvasRef} className="h-full w-full" />
          </div>

          {error && <p className="mt-3 text-center text-xs text-rose-400">{error}</p>}

          <div className="mt-4 flex gap-2">
            <button
              onClick={download}
              disabled={!ready}
              className="flex-1 rounded-xl bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-500 disabled:opacity-50"
            >
              Download PNG
            </button>
            {canCopyImage && (
              <button
                onClick={copyImage}
                disabled={!ready}
                className="rounded-xl border border-neutral-700 px-4 py-2.5 text-sm font-medium text-neutral-300 transition-colors hover:border-neutral-600 hover:text-neutral-100 disabled:opacity-50"
              >
                {copied ? "Copied" : "Copy image"}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
