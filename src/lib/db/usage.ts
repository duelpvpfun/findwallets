import "server-only";
import { sql } from "drizzle-orm";
import { getDb } from "./index";
import { apiUsage } from "./schema";

export type ApiProvider = "birdeye" | "solanatracker" | "helius";

/**
 * Records paid upstream spend. Calls are buffered in module memory and flushed
 * as one statement per (day, provider, endpoint) because a 500-wallet scan makes
 * ~50 upstream calls, and a write per call would cost more than the scan.
 *
 * Never allowed to affect the request it is measuring: all failures are swallowed.
 */
interface Pending {
  calls: number;
  credits: number;
  errors: number;
}

const pending = new Map<string, Pending>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;
const FLUSH_DELAY_MS = 2000;
// A serverless instance can be frozen between requests, so don't let the buffer
// grow unbounded waiting for a timer that may never fire.
const MAX_PENDING_KEYS = 200;

/** Birdeye bills compute units per endpoint; Solana Tracker bills per request. */
const BIRDEYE_CU: Record<string, number> = {
  "/defi/v2/tokens/top_traders": 35,
  "/wallet/v2/pnl/summary": 35,
  "/wallet/v2/pnl/details": 35,
  "/defi/v3/token/txs": 15,
  "/defi/v3/token/meta-data/single": 5,
  "/defi/v3/token/market-data": 5,
  "/defi/price": 5,
};

function creditsFor(provider: ApiProvider, endpoint: string): number {
  if (provider === "birdeye") return BIRDEYE_CU[endpoint] ?? 15;
  return 1;
}

export function trackApiCall(provider: ApiProvider, endpoint: string, failed = false): void {
  const key = `${provider}\u0000${endpoint}`;
  const entry = pending.get(key) ?? { calls: 0, credits: 0, errors: 0 };
  entry.calls++;
  entry.credits += creditsFor(provider, endpoint);
  if (failed) entry.errors++;
  pending.set(key, entry);

  if (pending.size >= MAX_PENDING_KEYS) {
    void flushApiUsage();
    return;
  }
  if (!flushTimer) {
    flushTimer = setTimeout(() => {
      flushTimer = null;
      void flushApiUsage();
    }, FLUSH_DELAY_MS);
    // Don't hold a serverless invocation open just to write a counter.
    flushTimer.unref?.();
  }
}

export async function flushApiUsage(): Promise<void> {
  if (pending.size === 0) return;
  const batch = [...pending.entries()];
  pending.clear();

  const db = getDb();
  if (!db) return;

  const today = new Date().toISOString().slice(0, 10);
  try {
    // One at a time: a scan can accumulate a counter per upstream endpoint, and
    // a wide concurrent fan-out on the pooled connection hangs instead of
    // queueing (see the comment in db/index.ts). This is a background counter
    // flush, so serial costs nothing anybody is waiting on.
    for (const [key, entry] of batch) {
      const [provider, endpoint] = key.split("\u0000");
      await db
        .insert(apiUsage)
        .values({
          day: today,
          provider,
          endpoint,
          calls: entry.calls,
          credits: entry.credits,
          errors: entry.errors,
        })
        .onConflictDoUpdate({
          target: [apiUsage.day, apiUsage.provider, apiUsage.endpoint],
          set: {
            calls: sql`${apiUsage.calls} + ${entry.calls}`,
            credits: sql`${apiUsage.credits} + ${entry.credits}`,
            errors: sql`${apiUsage.errors} + ${entry.errors}`,
            updatedAt: new Date(),
          },
        });
    }
  } catch {
    // Metrics are best-effort; a lost counter must never surface to a buyer.
  }
}
