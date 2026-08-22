import "server-only";
import { and, desc, eq, isNotNull, sql } from "drizzle-orm";
import { getDb } from "../db/index";
import { tokens } from "../db/schema";
import { fetchSolPriceUsd, fetchTokenMeta, fetchTokenSupply } from "../solanaTracker";
import { fetchSpotQuotes } from "../prices/free";
import { recordTokenPool } from "../db/alerts";

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
 *
 * **Free source first, 2026-08-22, and it was the single biggest paid line item
 * in the product.** `fetchTokenMeta` is two Solana Tracker credits per call, not
 * one: it fans out to `/tokens/{mint}` *and* `/price` for SOL. This runs once
 * per claimed tier, and the cache above almost never hits because the token is
 * new by definition — so on one live day it was 989 `/tokens` calls and 989 of
 * the day's 1,276 `/price` calls, against 372 total two days earlier. The whole
 * alert stream, not the paid scan path, had become the biggest consumer.
 *
 * DexScreener answers the same question in one free request, and answers it
 * BETTER: 21 calls were sitting on the feed with no entry cap at all — a
 * permanent "—" in the peak column, because a null denominator cannot produce a
 * multiple — and DexScreener priced every one of them that was checked by hand.
 * Solana Tracker returns no pool over the liquidity floor for a mint that new.
 *
 * The discipline is unchanged. Supply still comes from the chain and the cap is
 * still `price x supply`; DexScreener's own `marketCap` is only a last resort,
 * exactly as the pool's figure is in `fetchTokenMeta`. And Solana Tracker is
 * still the fallback, because DexScreener publishes no SLA and this number is
 * the denominator of every performance figure the call will ever report.
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

  const free = await freeSnapshot(mint);
  if (free) {
    // Native price is unknown from this source, and passing 0 leaves the stored
    // value alone — `cacheTokenSnapshot` coalesces, so nothing is overwritten
    // with a blank.
    await cacheTokenSnapshot(mint, free, 0);
    return free;
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
 * The same snapshot off DexScreener, or null if it does not know the mint.
 *
 * Two calls, neither of them a paid credit: one DexScreener request and one
 * `getTokenSupply` against the RPC. Null on anything missing rather than a
 * half-filled snapshot — a call with a price but no denominator would land on
 * the feed as a permanent dash, which is the failure this exists to remove.
 *
 * It also caches the pool. The peak pass needs a pool address before it can read
 * a candle, and resolving one costs a GeckoTerminal call out of a ~30-a-minute
 * budget the rotation is already rationing. DexScreener names the pair in the
 * response we are already parsing, so the very first peak check on a brand-new
 * call arrives with the lookup already paid for.
 */
async function freeSnapshot(mint: string): Promise<TokenSnapshot | null> {
  try {
    const quotes = await fetchSpotQuotes([mint]);
    const quote = quotes.get(mint);
    if (!quote) return null;

    // Chain supply, never marketCap/price — the rule from `fetchTokenMeta`. A
    // long-abandoned pool with $0.88 of liquidity still reports a price, and
    // dividing by it poisons the mcap of everything derived from that alert.
    const chainSupply = await fetchTokenSupply(mint);
    const supply = chainSupply > 0 ? chainSupply : null;
    const mcap = supply ? quote.priceUsd * supply : quote.marketCapUsd;
    if (!mcap || mcap <= 0) return null;

    if (quote.poolAddress) {
      // Best-effort. A failed write costs the peak pass one lookup later, never
      // the alert being announced.
      await recordTokenPool("solana", mint, quote.poolAddress, "dexscreener").catch(() => {});
    }

    return {
      symbol: quote.symbol,
      name: quote.name,
      imageUrl: quote.imageUrl,
      priceUsd: quote.priceUsd,
      mcapUsd: mcap,
      supply,
    };
  } catch (err) {
    // Never throws into the alert path: a free source failing must cost a
    // fallback, not the call.
    console.error(`[alerts/pricing] free snapshot failed for ${mint}:`, err);
    return null;
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
