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

/**
 * How long a SOL price is good enough to size a trade against a $50 floor.
 *
 * Ten minutes, not two. This is called on EVERY webhook delivery, and the
 * module cache is per serverless instance: at a two-minute TTL a handful of
 * warm instances would spend ~100k Solana Tracker requests a month re-reading a
 * number that moves fractions of a percent — over half the plan, to decide
 * whether a $52 buy is really $51.
 */
const SOL_PRICE_TTL_MS = 10 * 60 * 1000;

/** Wrapped SOL, which doubles as the row the shared price is cached on. */
const WSOL_MINT = "So11111111111111111111111111111111111111112";

interface CachedPrice {
  value: number;
  at: number;
}

// Per-instance, and deliberately backed by the database below: a cold start
// would otherwise pay for its own first read, and cold starts are frequent.
let cachedSolPrice: CachedPrice | null = null;

/**
 * SOL/USD, cheaply.
 *
 * Three layers, cheapest first: module memory, then the shared `tokens` row for
 * WSOL, then upstream. The middle layer is what makes the cost independent of
 * how many serverless instances happen to be warm — they all read and refresh
 * the same row, so the whole fleet costs about six upstream requests an hour
 * rather than six per instance.
 *
 * Returns `stale: true` when it fell back to a value it could not refresh. The
 * caller must treat that as an outage worth logging: if this ever returned 0,
 * every SOL-quoted buy would price at nothing, fall under the floor, and the
 * system would report a very quiet day instead of a broken one.
 */
export async function solPriceUsd(): Promise<{ price: number; stale: boolean }> {
  const now = Date.now();
  if (cachedSolPrice && now - cachedSolPrice.at < SOL_PRICE_TTL_MS) {
    return { price: cachedSolPrice.value, stale: false };
  }

  const db = getDb();

  // Shared cache. One indexed read, and we are already making DB calls on this
  // path, so it costs nothing extra in round trips that matter.
  if (db) {
    const [row] = await db
      .select({ price: tokens.priceUsd, at: tokens.lastScannedAt })
      .from(tokens)
      .where(and(eq(tokens.chain, "solana"), eq(tokens.address, WSOL_MINT)))
      .limit(1);
    if (row?.price && row.price > 0 && now - row.at.getTime() < SOL_PRICE_TTL_MS) {
      cachedSolPrice = { value: row.price, at: now };
      return { price: row.price, stale: false };
    }
  }

  try {
    const price = await fetchSolPriceUsd();
    if (price > 0) {
      cachedSolPrice = { value: price, at: now };
      await persistSolPrice(price);
      return { price, stale: false };
    }
  } catch (err) {
    console.error("[alerts/pricing] SOL price fetch failed:", err);
  }

  // A previously good value beats anything else, and both beat zero.
  if (cachedSolPrice) return { price: cachedSolPrice.value, stale: true };

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

/** Write the shared price back. Best-effort: a failure here costs one extra
 * upstream read later, never the delivery being processed. */
async function persistSolPrice(price: number): Promise<void> {
  const db = getDb();
  if (!db) return;
  try {
    await db
      .insert(tokens)
      .values({
        chain: "solana",
        address: WSOL_MINT,
        symbol: "SOL",
        name: "Wrapped SOL",
        priceUsd: price,
        nativePriceUsd: price,
        scanCount: 0,
      })
      .onConflictDoUpdate({
        target: [tokens.chain, tokens.address],
        set: { priceUsd: price, nativePriceUsd: price, lastScannedAt: new Date() },
      });
  } catch (err) {
    console.error("[alerts/pricing] could not cache SOL price:", err);
  }
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
