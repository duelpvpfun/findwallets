import "server-only";

/**
 * Free market-cap sources, so tracking costs no paid credits.
 *
 * Two providers, two different jobs, and the split matters:
 *
 *  - **DexScreener** answers "what is it worth now". Free, no key, and it takes
 *    up to 30 mints in one request, so a whole tracking sweep is a handful of
 *    calls.
 *  - **GeckoTerminal** answers "what was the highest it ever traded", by
 *    returning OHLCV candles. This is the one that fixes a real defect rather
 *    than just saving money: a running maximum of spot checks is not an
 *    all-time high. $Link was recorded at $1.19M because that was the highest
 *    of seven glances; it actually traded at $2.22M, and its whole run above
 *    $1.3M lasted thirteen minutes. **A candle high cannot be missed by
 *    polling slowly** — a spike at 04:29 is in the 04:29 candle forever — so
 *    correctness stops depending on cadence and the rotation only has to keep
 *    the *displayed* number fresh.
 *
 * Neither has an SLA, which is why Solana Tracker stays wired as the fallback
 * in the caller rather than being deleted. Every function here resolves rather
 * than throws: a tracking sweep that dies loses a sample, and losing a sample
 * must never be able to lose the running maximum with it.
 */

/** Free tiers are generous but not unlimited, and a tracking sweep must never
 * be the reason an endpoint starts refusing us. DexScreener documents 300/min
 * on the token endpoint; GeckoTerminal's free tier is ~30/min. */
const DEXSCREENER_BATCH = 30;
const REQUEST_TIMEOUT_MS = 8000;

/** Politeness gap between GeckoTerminal calls. At 30/min the floor is 2s; this
 * sits just above it so a burst at the start of a sweep cannot trip the limit. */
const GECKO_MIN_GAP_MS = 2200;

async function getJson<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url, {
      headers: { accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

// --- Spot market cap: DexScreener ---

interface DexPair {
  baseToken?: { address?: string };
  priceUsd?: string;
  marketCap?: number;
  fdv?: number;
  liquidity?: { usd?: number };
  pairAddress?: string;
  dexId?: string;
}

export interface SpotQuote {
  priceUsd: number;
  marketCapUsd: number | null;
  /** Handy for the pool cache — DexScreener already knows the pair. */
  poolAddress: string | null;
}

/**
 * Current price and market cap for many mints at once.
 *
 * **The deepest pool wins.** A token routinely has several pairs, and a thin
 * one prints a price nobody could trade at — which on a memecoin is the
 * difference between a real figure and a wick. Picking by liquidity is the only
 * defensible tie-break available in this payload.
 */
export async function fetchSpotQuotes(mints: string[]): Promise<Map<string, SpotQuote>> {
  const out = new Map<string, SpotQuote>();

  for (let i = 0; i < mints.length; i += DEXSCREENER_BATCH) {
    const chunk = mints.slice(i, i + DEXSCREENER_BATCH);
    const data = await getJson<{ pairs?: DexPair[] }>(
      `https://api.dexscreener.com/latest/dex/tokens/${chunk.join(",")}`
    );
    // A dead batch costs those tokens one sample. The running maximum is
    // unaffected, so it must never abort the rest of the sweep.
    if (!data?.pairs) continue;

    const best = new Map<string, { liq: number; pair: DexPair }>();
    for (const pair of data.pairs) {
      const mint = pair.baseToken?.address;
      if (!mint) continue;
      const liq = pair.liquidity?.usd ?? 0;
      const current = best.get(mint);
      if (!current || liq > current.liq) best.set(mint, { liq, pair });
    }

    for (const [mint, { pair }] of best) {
      const price = Number(pair.priceUsd);
      if (!Number.isFinite(price) || price <= 0) continue;
      const mcap = pair.marketCap ?? pair.fdv ?? null;
      out.set(mint, {
        priceUsd: price,
        marketCapUsd: typeof mcap === "number" && Number.isFinite(mcap) && mcap > 0 ? mcap : null,
        poolAddress: pair.pairAddress ?? null,
      });
    }
  }

  return out;
}

// --- True peak: GeckoTerminal OHLCV ---

const GECKO_BASE = "https://api.geckoterminal.com/api/v2/networks/solana";

let lastGeckoCallAt = 0;

/** Serialises GeckoTerminal calls with a minimum gap. The sweep is already
 * sequential for database reasons, so this costs no extra wall clock beyond the
 * gap itself. */
async function geckoThrottle(): Promise<void> {
  const wait = lastGeckoCallAt + GECKO_MIN_GAP_MS - Date.now();
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  lastGeckoCallAt = Date.now();
}

/** The pool a mint trades in, deepest first — same reasoning as above. */
export async function resolvePoolAddress(mint: string): Promise<string | null> {
  await geckoThrottle();
  const data = await getJson<{
    data?: Array<{ id?: string; attributes?: { reserve_in_usd?: string } }>;
  }>(`${GECKO_BASE}/tokens/${mint}/pools`);
  if (!data?.data?.length) return null;

  let best: { id: string; reserve: number } | null = null;
  for (const pool of data.data) {
    const id = pool.id?.replace(/^solana_/, "");
    if (!id) continue;
    const reserve = Number(pool.attributes?.reserve_in_usd ?? 0);
    if (!best || reserve > best.reserve) best = { id, reserve };
  }
  return best?.id ?? null;
}

export interface PeakSample {
  /** Highest price traded in the window, from candle highs. */
  highPriceUsd: number;
  /** When that candle opened, which is the peak's time to within the interval. */
  highAt: Date;
}

/**
 * The highest price a pool traded between two times.
 *
 * Minute candles for anything inside the last day, hourly beyond it. That is
 * not a cost decision — one call returns up to 1,000 candles either way — it is
 * a coverage one: 1,000 minutes is under 17 hours, so a week-old call needs the
 * coarser interval to be covered by a single request at all. The peak of a
 * memecoin is almost always in the first hours, where the minute resolution is.
 */
export async function fetchPeakSince(
  poolAddress: string,
  since: Date,
  mint: string
): Promise<PeakSample | null> {
  const ageHours = (Date.now() - since.getTime()) / 3_600_000;
  const interval = ageHours <= 16 ? "minute" : "hour";

  await geckoThrottle();
  // **`token=` is not optional.** OHLCV defaults to the pool's BASE token, and
  // our mint is regularly the quote side — $ELOTÉ's deepest pool is "ZEC /
  // ELOTÉ", so the default returned ZEC at $834 and multiplying that by ELOTÉ's
  // billion-token supply produced a $834 BILLION peak on the public podium.
  // Naming the token we want is the whole guard against reading a completely
  // different asset's price.
  const data = await getJson<{
    data?: { attributes?: { ohlcv_list?: number[][] } };
  }>(
    `${GECKO_BASE}/pools/${poolAddress}/ohlcv/${interval}` +
      `?aggregate=1&limit=1000&currency=usd&token=${mint}`
  );

  const candles = data?.data?.attributes?.ohlcv_list;
  if (!candles?.length) return null;

  // [timestamp, open, high, low, close, volume]
  const sinceSeconds = Math.floor(since.getTime() / 1000);
  let best: PeakSample | null = null;
  for (const candle of candles) {
    const at = candle[0];
    const high = candle[2];
    // Candles before the call are somebody else's run, not ours. Scoring a
    // peak the alert was never in front of would be inventing a win.
    if (typeof at !== "number" || at < sinceSeconds) continue;
    if (typeof high !== "number" || !Number.isFinite(high) || high <= 0) continue;
    if (!best || high > best.highPriceUsd) {
      best = { highPriceUsd: high, highAt: new Date(at * 1000) };
    }
  }
  return best;
}
