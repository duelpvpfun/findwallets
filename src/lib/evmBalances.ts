// On-chain ERC-20 balance reads for EVM chains.
//
// WHY THIS EXISTS: Birdeye's top_traders `unrealizedPnl` is derived from
// (volumeBuy - volumeSell) inside the ranking window, not from a real balance.
// Tokens that left the wallet by transfer — or were sold outside the indexed
// pools/window — still count as "held", so a wallet that exited completely can
// be reported as sitting on a seven-figure position. Confirmed live: wallet
// 0x40370ECc… on 0xBEEA1D61… showed unrealizedPnl $1.09M with an on-chain
// balance of exactly 0. A balanceOf call is free and authoritative, so we read
// the chain instead of trusting the derived figure.
import "server-only";
import type { Chain } from "./types";

type EvmChain = Extract<Chain, "bsc" | "base">;

const RPC_URLS: Record<EvmChain, string> = {
  bsc: process.env.BSC_RPC_URL || "https://bsc-dataseed.binance.org",
  base: process.env.BASE_RPC_URL || "https://mainnet.base.org",
};

// balanceOf(address) and decimals() selectors.
const BALANCE_OF = "0x70a08231";
const DECIMALS = "0x313ce567";

// Confirmed live against the default public nodes: BSC rejects eth_call batches
// around 50 (-32005), Base hard-caps at 10 per batch (-32014) and throttles at
// 10 (-32016). Both numbers are the public-endpoint ceiling; a paid RPC via
// BSC_RPC_URL / BASE_RPC_URL will tolerate far more.
const BATCH_SIZE: Record<EvmChain, number> = { bsc: 20, base: 5 };
const MAX_ATTEMPTS = 4;
const RATE_LIMIT_CODES = new Set([-32005, -32016]);

interface RpcResponse {
  id: number | null;
  result?: string;
  error?: { code?: number; message: string };
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function rpcBatch(chain: EvmChain, calls: Array<{ to: string; data: string }>) {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(RPC_URLS[chain], {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(
        calls.map((c, i) => ({
          jsonrpc: "2.0",
          id: i,
          method: "eth_call",
          params: [{ to: c.to, data: c.data }, "latest"],
        }))
      ),
      cache: "no-store",
    });
    if (!res.ok) throw new Error(`RPC ${res.status}`);
    const body = (await res.json()) as RpcResponse[] | RpcResponse;
    const list = Array.isArray(body) ? body : [body];

    // Throttling surfaces either as one id:null error or as an error on every
    // entry, so retry the whole batch rather than reading empties as real data.
    if (list.some((r) => r.error && RATE_LIMIT_CODES.has(r.error.code ?? 0))) {
      if (attempt >= MAX_ATTEMPTS) throw new Error("RPC batch rate limited");
      await sleep(500 * 2 ** (attempt - 1));
      continue;
    }

    const out = new Array<string | null>(calls.length).fill(null);
    for (const item of list) {
      if (typeof item.id === "number" && item.result) out[item.id] = item.result;
    }
    return out;
  }
}

function toNumber(hex: string | null, decimals: number): number | null {
  if (!hex || hex === "0x") return null;
  try {
    return Number(BigInt(hex)) / 10 ** decimals;
  } catch {
    return null;
  }
}

export async function fetchTokenDecimals(chain: EvmChain, token: string): Promise<number | null> {
  try {
    const [hex] = await rpcBatch(chain, [{ to: token, data: DECIMALS }]);
    if (!hex || hex === "0x") return null;
    const value = Number(BigInt(hex));
    return Number.isFinite(value) && value >= 0 && value <= 36 ? value : null;
  } catch {
    return null;
  }
}

/**
 * Live token balance per wallet, in whole-token units.
 *
 * A wallet missing from the returned map means the read failed — callers must
 * treat that as unknown, never as zero, so a flaky RPC can't wipe a real
 * position out of the UI.
 */
export async function fetchTokenBalances(
  chain: EvmChain,
  token: string,
  wallets: string[],
  decimals: number
): Promise<Map<string, number>> {
  const balances = new Map<string, number>();
  if (wallets.length === 0) return balances;

  const size = BATCH_SIZE[chain];
  for (let start = 0; start < wallets.length; start += size) {
    const slice = wallets.slice(start, start + size);
    const calls = slice.map((w) => ({
      to: token,
      data: BALANCE_OF + w.slice(2).toLowerCase().padStart(64, "0"),
    }));
    try {
      const results = await rpcBatch(chain, calls);
      results.forEach((hex, i) => {
        const value = toNumber(hex, decimals);
        if (value !== null) balances.set(slice[i].toLowerCase(), value);
      });
    } catch {
      // Leave this batch absent so the caller reports "unknown", not zero.
    }
    if (start + size < wallets.length) await sleep(120);
  }

  return balances;
}
