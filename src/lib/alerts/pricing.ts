import "server-only";
import { and, desc, eq, isNotNull, sql } from "drizzle-orm";
import { getDb } from "../db/index";
import { tokens } from "../db/schema";
import { fetchSolPriceUsd, fetchTokenMeta, fetchTokenSupply } from "../solanaTracker";

/**
 * Pricing for the alert engine.
 *
 * Two jobs, both of which have to survive an upstream outage without silently
 * turning the product off:
 *
 *  - a SOL price, to size every SOL-quoted trade against the $50 floor;
 *  - a token snapshot, to pin the market cap an alert fired at.
 *
 * The first is the dangerous one. If the SOL price is unavailable, every buy
 * prices at $0, every buy falls under the floor, and the system reports a very
 * quiet day rather than an outage. That is why it falls back to the database
 * before it gives up, and why giving up is logged loudly.
 */

const SOL_PRICE_TTL_MS = 120_000;

interface CachedPrice {
  value: number;
  at: number;
}

// Module scope: a warm serverless instance handles many deliveries, and the
// SOL price does not move enough in two minutes to matter to a $50 floor.
let cachedSolPrice: CachedPrice | null = null;

/**
 * SOL/USD, at most one upstream call every two minutes per warm instance.
 *
 * Falls back to the most recent price any scan recorded before it returns 0.
 * `tokens.native_price_usd` is written on every scan, so in practice this is
 * hours old at worst — far better than pricing every trade at nothing.
 */
export async function solPriceUsd(): Promise<{ price: number; stale: boolean }> {
  const now = Date.now();
  if (cachedSolPrice && now - cachedSolPrice.at < SOL_PRICE_TTL_MS) {
    return { price: cachedSolPrice.value, stale: false };
  }

  try {
    const price = await fetchSolPriceUsd();
    if (price > 0) {
      cachedSolPrice = { value: price, at: now };
      return { price, stale: false };
    }
  } catch (err) {
    console.error("[alerts/pricing] SOL price fetch failed:", err);
  }

  // A previously good value beats the database, and both beat zero.
  if (cachedSolPrice) return { price: cachedSolPrice.value, stale: true };

  const db = getDb();
  if (db) {
    const [row] = await db
      .select({ price: tokens.nativePriceUsd })
      .from(tokens)
      .where(and(eq(tokens.chain, "solana"), isNotNull(tokens.nativePriceUsd)))
      .orderBy(desc(tokens.lastScannedAt))
      .limit(1);
    if (row?.price && row.price > 0) {
      cachedSolPrice = { value: row.price, at: now };
      return { price: row.price, stale: true };
    }
  }

  console.error("[alerts/pricing] no SOL price available from any source");
  return { price: 0, stale: true };
}

export interface TokenSnapshot {
  symbol: string | null;
  name: string | null;
  imageUrl: string | null;
  priceUsd: number | null;
  mcapUsd: number | null;
  supply: number | null;
}

/** How long a stored token row is good enough to serve an alert snapshot from
 * without re-hitting upstream. Short, because the market cap it pins is the
 * denominator of every performance figure that alert will ever report. */
const SNAPSHOT_FRESH_MS = 5 * 60 * 1000;

/**
 * Identity and market cap for a token at the instant an alert fires.
 *
 * Reads the local `tokens` row first — a token that was scanned minutes ago
 * needs no upstream call — and writes back whatever it learns, so the next
 * alert on the same token is free and the wallet ticker gets fresher data as a
 * side effect.
 *
 * Supply comes from the chain, and the cap is `price x supply`, matching
 * `fetchTokenMeta`. Every figure in the app then shares one source of truth
 * instead of trusting a pool's self-reported market cap.
 */
export async function fetchAlertTokenSnapshot(mint: string): Promise<TokenSnapshot> {
  const db = getDb();

  if (db) {
    const [row] = await db
      .select({
        symbol: tokens.symbol,
        name: tokens.name,
        imageUrl: tokens.imageUrl,
        priceUsd: tokens.priceUsd,
        marketCapUsd: tokens.marketCapUsd,
        estimatedSupply: tokens.estimatedSupply,
        lastScannedAt: tokens.lastScannedAt,
      })
      .from(tokens)
      .where(and(eq(tokens.chain, "solana"), eq(tokens.address, mint)))
      .limit(1);

    if (
      row &&
      row.priceUsd &&
      row.estimatedSupply &&
      Date.now() - row.lastScannedAt.getTime() < SNAPSHOT_FRESH_MS
    ) {
      return {
        symbol: row.symbol,
        name: row.name,
        imageUrl: row.imageUrl,
        priceUsd: row.priceUsd,
        mcapUsd: row.marketCapUsd ?? row.priceUsd * row.estimatedSupply,
        supply: row.estimatedSupply,
      };
    }
  }

  try {
    const meta = await fetchTokenMeta(mint);
    const snapshot: TokenSnapshot = {
      symbol: meta.symbol || null,
      name: meta.name || null,
      imageUrl: meta.imageUrl,
      priceUsd: meta.priceUsd > 0 ? meta.priceUsd : null,
      mcapUsd: meta.marketCapUsd > 0 ? meta.marketCapUsd : null,
      supply: meta.estimatedSupply > 0 ? meta.estimatedSupply : null,
    };
    await cacheTokenSnapshot(mint, snapshot, meta.nativePriceUsd);
    return snapshot;
  } catch (err) {
    console.error(`[alerts/pricing] token meta failed for ${mint}:`, err);
    return { symbol: null, name: null, imageUrl: null, priceUsd: null, mcapUsd: null, supply: null };
  }
}

/**
 * Write an alert's token into the shared `tokens` table.
 *
 * `scan_count` is deliberately NOT incremented: nobody paid to scan this token,
 * and letting the alert stream inflate that counter would corrupt the admin
 * dashboard's view of what customers actually bought.
 */
async function cacheTokenSnapshot(
  mint: string,
  snapshot: TokenSnapshot,
  nativePriceUsd: number
): Promise<void> {
  const db = getDb();
  if (!db) return;

  await db
    .insert(tokens)
    .values({
      chain: "solana",
      address: mint,
      symbol: snapshot.symbol,
      name: snapshot.name,
      imageUrl: snapshot.imageUrl,
      priceUsd: snapshot.priceUsd,
      marketCapUsd: snapshot.mcapUsd,
      nativePriceUsd: nativePriceUsd || null,
      estimatedSupply: snapshot.supply,
      scanCount: 0,
    })
    .onConflictDoUpdate({
      target: [tokens.chain, tokens.address],
      set: {
        symbol: sql`coalesce(excluded.symbol, ${tokens.symbol})`,
        name: sql`coalesce(excluded.name, ${tokens.name})`,
        imageUrl: sql`coalesce(excluded.image_url, ${tokens.imageUrl})`,
        priceUsd: sql`coalesce(excluded.price_usd, ${tokens.priceUsd})`,
        marketCapUsd: sql`coalesce(excluded.market_cap_usd, ${tokens.marketCapUsd})`,
        nativePriceUsd: sql`coalesce(excluded.native_price_usd, ${tokens.nativePriceUsd})`,
        estimatedSupply: sql`coalesce(excluded.estimated_supply, ${tokens.estimatedSupply})`,
        lastScannedAt: new Date(),
      },
    });
}

/** Chain supply for a token whose alert snapshot never got one — without it
 * every later sample would have nothing to multiply a price by. */
export async function resolveSupply(mint: string): Promise<number | null> {
  const supply = await fetchTokenSupply(mint);
  return supply > 0 ? supply : null;
}
