import { NextResponse, type NextRequest } from "next/server";
import { clientIp, rateLimit } from "@/lib/rateLimit";
import { ALLOWED_CHAINS, detectAddressFamily, isChain, normalizeAddress } from "@/lib/chains";
import type { Chain } from "@/lib/types";

export const dynamic = "force-dynamic";

const MAX_REQUESTS_PER_MINUTE = 30;

/**
 * Which chain a pasted contract address actually lives on.
 *
 * A `0x` address is valid on every EVM chain, so the paste alone identifies the
 * family and nothing more. That used to be handled by guessing — an EVM paste
 * switched the picker to BNB Chain — which was defensible with two EVM chains
 * and wrong two times in three with a third. Guessing was then removed, which
 * traded a wrong guess for a dead end: the buyer submitted and got told "Switch
 * to BNB Chain, Base or Robinhood", i.e. asked to do the identifying themselves.
 *
 * Dexscreener answers it outright. One unauthenticated call returns every pair
 * for that address across every chain it indexes, each tagged with `chainId`, so
 * the answer is looked up instead of assumed.
 *
 * Three properties this has to keep:
 *
 *  - **Free, and never a credit.** It runs on every paste, so it cannot touch a
 *    paid provider or the entitlement path. Dexscreener needs no key.
 *  - **Advisory only.** It moves a picker. `/api/top-traders` still validates the
 *    chain it is given and still refuses a mismatch, so a wrong answer here
 *    costs a tap, never a scan. Nothing about entitlement moves to the browser.
 *  - **Silent on failure.** No pair data, an outage, a chain we do not support:
 *    all return `{ chain: null }` and the picker stays where the buyer left it.
 *    A resolver that throws would be worse than the guess it replaced.
 */
const DEXSCREENER_TOKENS = "https://api.dexscreener.com/latest/dex/tokens";

/** Dexscreener's chain slugs happen to match ours for every chain we support,
 * but only because both follow the common name — so the mapping is explicit
 * rather than a cast. An unknown slug means a chain we do not scan. */
const CHAIN_BY_SLUG: Record<string, Chain> = {
  solana: "solana",
  bsc: "bsc",
  base: "base",
  robinhood: "robinhood",
};

interface DexPair {
  chainId?: string;
  liquidity?: { usd?: number };
}

export async function GET(request: NextRequest) {
  const limit = await rateLimit(
    `resolvechain:${clientIp(request)}`,
    MAX_REQUESTS_PER_MINUTE,
    60_000
  );
  if (!limit.ok) {
    return NextResponse.json(
      { error: "Too many requests." },
      { status: 429, headers: { "Retry-After": String(limit.retryAfterSeconds) } }
    );
  }

  const address = (request.nextUrl.searchParams.get("address") ?? "").trim();
  const family = detectAddressFamily(address);
  // Shape-checked before it reaches upstream: this endpoint is unauthenticated,
  // so it must not forward arbitrary strings to a third party on request.
  if (family === null) {
    return NextResponse.json({ chain: null }, { headers: { "Cache-Control": "no-store" } });
  }

  try {
    const res = await fetch(`${DEXSCREENER_TOKENS}/${encodeURIComponent(address)}`, {
      cache: "no-store",
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) throw new Error(`dexscreener ${res.status}`);
    const body = (await res.json()) as { pairs?: DexPair[] | null };

    // Summed liquidity per chain, not pair count. The same address can be
    // deployed on several chains and one of them is usually the real market;
    // counting pairs would let a handful of empty pools outvote it.
    const byChain = new Map<Chain, number>();
    for (const pair of body.pairs ?? []) {
      const chain = pair.chainId ? CHAIN_BY_SLUG[pair.chainId] : undefined;
      if (!chain || !isChain(chain)) continue;
      // A family mismatch means Dexscreener indexed something we would refuse
      // anyway — an EVM address can never be the answer for Solana.
      if ((chain === "solana") !== (family === "solana")) continue;
      byChain.set(chain, (byChain.get(chain) ?? 0) + (pair.liquidity?.usd ?? 0));
    }

    let best: Chain | null = null;
    let bestLiquidity = -1;
    // Iterated in ALLOWED_CHAINS order so a tie — two chains with no reported
    // liquidity at all — resolves the same way on every request.
    for (const chain of ALLOWED_CHAINS) {
      const liquidity = byChain.get(chain);
      if (liquidity === undefined) continue;
      if (liquidity > bestLiquidity) {
        best = chain;
        bestLiquidity = liquidity;
      }
    }

    return NextResponse.json(
      { chain: best, address: best ? normalizeAddress(best, address) : address },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch {
    // Advisory endpoint: an upstream failure leaves the picker alone rather than
    // surfacing an error for something the buyer did not ask for.
    return NextResponse.json({ chain: null }, { headers: { "Cache-Control": "no-store" } });
  }
}
