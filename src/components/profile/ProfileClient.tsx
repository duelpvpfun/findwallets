"use client";

import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { formatUsd, shortenAddress } from "@/lib/format";
import { walletFamily } from "@/lib/auth/wallet";
import { saveScan, type CachedScan } from "@/lib/scanCache";
import type { CreditBalance } from "@/components/AccountProvider";
import ProfileShell from "./ProfileShell";

export interface PurchaseView {
  paymentId: string;
  method: string | null;
  tier: number;
  priceUsd: number | null;
  createdAt: string;
  consumedAt: string | null;
  consumedChain: string | null;
  consumedTokenAddress: string | null;
  consumedTokenSymbol: string | null;
}

export interface ResultView {
  id: number;
  chain: string;
  tokenAddress: string;
  tokenSymbol: string | null;
  traderCount: number;
  requestedCount: number | null;
  pinned: boolean;
  createdAt: string;
  expiresAt: string;
}

interface ProfileClientProps {
  wallet: string;
  balance: CreditBalance;
  purchases: PurchaseView[];
  results: ResultView[];
  retentionDays: number;
  maxPinned: number;
}

const CHAIN_LABELS: Record<string, string> = {
  solana: "Solana",
  bsc: "BNB Chain",
  base: "Base",
};

export default function ProfileClient({
  wallet,
  balance,
  purchases,
  results,
  retentionDays,
  maxPinned,
}: ProfileClientProps) {
  const router = useRouter();
  const [rows, setRows] = useState(results);
  const [openingId, setOpeningId] = useState<number | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  /**
   * Re-opens a stored result in the main table.
   *
   * Reads the saved payload and hands it to the same session cache a live scan
   * writes to, so the results page restores it exactly as it would after a
   * refresh. No upstream API is called and no credit is touched — spending
   * someone's API quota twice for one purchase is the thing this exists to stop.
   */
  const open = useCallback(
    async (id: number) => {
      setOpeningId(id);
      setNotice(null);
      try {
        const res = await fetch(`/api/scan-results/${id}`, { cache: "no-store" });
        const data = await res.json();
        if (!res.ok) {
          setNotice(data?.error ?? "Could not load that result.");
          return;
        }
        saveScan(data as CachedScan);
        router.push("/");
      } catch {
        setNotice("Could not reach the server.");
      } finally {
        setOpeningId(null);
      }
    },
    [router]
  );

  const togglePin = useCallback(async (id: number, pinned: boolean) => {
    setNotice(null);
    try {
      const res = await fetch(`/api/scan-results/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pinned }),
      });
      const data = await res.json();
      if (!res.ok) {
        setNotice(data?.error ?? "Could not update that result.");
        return;
      }
      setRows((prev) => prev.map((r) => (r.id === id ? { ...r, pinned } : r)));
    } catch {
      setNotice("Could not reach the server.");
    }
  }, []);

  return (
    <ProfileShell>
      <div className="space-y-6">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-neutral-50">Your account</h1>
          <p className="mt-1 font-mono text-[11px] text-neutral-500">{wallet}</p>
        </div>

        {notice && (
          <div className="animate-fade-in rounded-xl border border-amber-900/50 bg-amber-950/25 px-4 py-3 text-sm text-amber-200">
            {notice}
          </div>
        )}

        {/* Balance */}
        <section className="rounded-2xl border border-neutral-800 bg-neutral-900/40">
          <div className="grid grid-cols-3 divide-neutral-800/80 sm:divide-x">
            <Stat label="Scans available" value={String(balance.total)} accent />
            <Stat label="Held by a scan" value={String(balance.pending)} />
            <Stat label="Purchases" value={String(purchases.length)} />
          </div>

          {balance.byTier.length > 0 && (
            <div className="flex flex-wrap items-center gap-2 border-t border-neutral-800/80 px-4 py-3 sm:px-5">
              <span className="text-[11px] text-neutral-500">Ready to spend:</span>
              {balance.byTier.map((t) => (
                <span
                  key={t.tier}
                  className="tnum rounded-md bg-emerald-500/10 px-2 py-0.5 text-[11px] font-semibold text-emerald-300"
                >
                  {t.count}× Top {t.tier}
                </span>
              ))}
            </div>
          )}

          {balance.total === 0 && (
            <div className="flex flex-wrap items-center gap-3 border-t border-neutral-800/80 px-4 py-3.5 sm:px-5">
              <span className="text-sm text-neutral-400">No credits left.</span>
              <Link
                href="/"
                className="rounded-lg bg-gradient-to-b from-blue-500 to-blue-600 px-3.5 py-1.5 text-xs font-semibold text-white transition-all hover:from-blue-400 hover:to-blue-500"
              >
                Buy another scan
              </Link>
            </div>
          )}
        </section>

        {/* Saved results */}
        <section>
          <div className="mb-2.5 flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-sm font-semibold text-neutral-100">Saved results</h2>
            <p className="text-[11px] text-neutral-500">
              Kept for {retentionDays} days. Export anything you want to keep. Pin up to{" "}
              {maxPinned} to keep them indefinitely.
            </p>
          </div>

          {rows.length === 0 ? (
            <EmptyCard>
              Nothing saved yet. Every paid scan from now on is stored here for {retentionDays} days,
              so you can re-download it without paying again.
            </EmptyCard>
          ) : (
            <div className="overflow-hidden rounded-2xl border border-neutral-800 bg-neutral-900/40">
              {rows.map((r) => (
                <ResultRow
                  key={r.id}
                  row={r}
                  busy={openingId === r.id}
                  onOpen={() => void open(r.id)}
                  onTogglePin={() => void togglePin(r.id, !r.pinned)}
                />
              ))}
            </div>
          )}
        </section>

        {/* Purchases */}
        <section>
          <h2 className="mb-2.5 text-sm font-semibold text-neutral-100">Purchase history</h2>
          {purchases.length === 0 ? (
            <EmptyCard>
              No purchases attached to this wallet. Purchases follow the wallet that sent the
              payment, so if you paid from a different one, connect that wallet instead.
              {walletFamily(wallet) === "evm" && (
                <>
                  {" "}
                  Payment is in SOL or USDC on Solana, so anything you bought before this account
                  existed is attached to the Solana wallet that paid for it.
                </>
              )}
            </EmptyCard>
          ) : (
            <div className="overflow-hidden rounded-2xl border border-neutral-800 bg-neutral-900/40">
              {purchases.map((p) => (
                <PurchaseRow key={p.paymentId} row={p} />
              ))}
            </div>
          )}
        </section>
      </div>
    </ProfileShell>
  );
}

function Stat({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="border-b border-neutral-800/80 px-4 py-3.5 sm:border-b-0 sm:px-5">
      <div className="text-[10px] uppercase tracking-wider text-neutral-500">{label}</div>
      <div
        className={`tnum mt-1 text-xl font-semibold ${
          accent ? "text-emerald-400" : "text-neutral-100"
        }`}
      >
        {value}
      </div>
    </div>
  );
}

function EmptyCard({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-dashed border-neutral-800 bg-neutral-900/20 px-4 py-6 text-center text-[13px] leading-relaxed text-neutral-500 sm:px-8">
      {children}
    </div>
  );
}

/**
 * Time left before a result is purged. Spelled out per row rather than as a
 * blanket notice: "expires in 2 days" is actionable, "we keep things for a
 * while" is not.
 */
function expiryLabel(expiresAt: string, pinned: boolean): { text: string; urgent: boolean } {
  if (pinned) return { text: "Kept indefinitely", urgent: false };
  const ms = new Date(expiresAt).getTime() - Date.now();
  if (ms <= 0) return { text: "Expired", urgent: true };
  const hours = Math.floor(ms / 3_600_000);
  if (hours < 24) {
    return { text: `Expires in ${Math.max(1, hours)}h`, urgent: true };
  }
  const days = Math.round(hours / 24);
  return { text: `Expires in ${days} day${days === 1 ? "" : "s"}`, urgent: days <= 2 };
}

function ResultRow({
  row,
  busy,
  onOpen,
  onTogglePin,
}: {
  row: ResultView;
  busy: boolean;
  onOpen: () => void;
  onTogglePin: () => void;
}) {
  const expiry = expiryLabel(row.expiresAt, row.pinned);
  const short = row.traderCount < (row.requestedCount ?? row.traderCount);

  return (
    <div className="flex flex-wrap items-center gap-3 border-b border-neutral-900/70 px-4 py-3.5 last:border-b-0 sm:px-5">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-semibold text-neutral-100">
            ${row.tokenSymbol ?? shortenAddress(row.tokenAddress, 4)}
          </span>
          <span className="rounded bg-neutral-800 px-1.5 py-0.5 text-[10px] font-medium text-neutral-400">
            {CHAIN_LABELS[row.chain] ?? row.chain}
          </span>
          <span className="tnum text-[11px] text-neutral-500">
            {row.traderCount} wallets
            {short && row.requestedCount ? ` of ${row.requestedCount}` : ""}
          </span>
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px]">
          <span className="text-neutral-500">
            {new Date(row.createdAt).toLocaleDateString(undefined, {
              month: "short",
              day: "numeric",
              hour: "2-digit",
              minute: "2-digit",
            })}
          </span>
          <span className={expiry.urgent ? "text-amber-400" : "text-neutral-500"}>
            · {expiry.text}
          </span>
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-2">
        <button
          onClick={onTogglePin}
          title={row.pinned ? "Let this expire normally" : "Keep this one indefinitely"}
          aria-pressed={row.pinned}
          className={`rounded-lg border px-2.5 py-1.5 text-[11px] font-medium transition-colors ${
            row.pinned
              ? "border-amber-700/60 bg-amber-950/30 text-amber-300"
              : "border-neutral-800 text-neutral-400 hover:border-neutral-700 hover:text-neutral-200"
          }`}
        >
          {row.pinned ? "Pinned" : "Pin"}
        </button>
        <button
          onClick={onOpen}
          disabled={busy}
          className="rounded-lg border border-neutral-700 px-3 py-1.5 text-[11px] font-semibold text-neutral-100 transition-colors hover:border-neutral-600 hover:bg-neutral-800 disabled:opacity-50"
        >
          {busy ? "Opening…" : "Open"}
        </button>
      </div>
    </div>
  );
}

function PurchaseRow({ row }: { row: PurchaseView }) {
  const spentOn = row.consumedTokenAddress
    ? `$${row.consumedTokenSymbol ?? shortenAddress(row.consumedTokenAddress, 4)}`
    : null;

  return (
    <div className="flex flex-wrap items-center gap-3 border-b border-neutral-900/70 px-4 py-3 last:border-b-0 sm:px-5">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[13px] font-medium text-neutral-100">Top {row.tier}</span>
          {row.priceUsd !== null && (
            <span className="tnum text-[11px] text-neutral-500">{formatUsd(row.priceUsd)}</span>
          )}
          {row.method && (
            <span className="rounded bg-neutral-800 px-1.5 py-0.5 text-[10px] uppercase text-neutral-400">
              {row.method}
            </span>
          )}
        </div>
        <div className="mt-0.5 text-[11px] text-neutral-500">
          {new Date(row.createdAt).toLocaleDateString(undefined, {
            year: "numeric",
            month: "short",
            day: "numeric",
          })}
          {spentOn ? ` · spent on ${spentOn}` : ""}
        </div>
      </div>
      <span
        className={`shrink-0 rounded-md px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
          row.consumedAt
            ? "bg-neutral-800 text-neutral-400"
            : "bg-emerald-500/15 text-emerald-300"
        }`}
      >
        {row.consumedAt ? "Used" : "Unused"}
      </span>
    </div>
  );
}
