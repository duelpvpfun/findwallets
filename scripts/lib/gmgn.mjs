// Minimal client for GMGN's free OpenAPI (openapi.gmgn.ai).
//
// Two auth modes. Read routes take just X-APIKEY plus timestamp/client_id query
// params. `wallet_holdings` additionally needs X-Signature over
// `{subPath}:{sortedQuery}:{body}:{timestamp}` — the query string must be sorted
// by key and include timestamp/client_id, or the server rejects it.
//
// The server validates timestamp within ±5s and rejects replayed client_ids
// within 7s, so every attempt has to be re-signed rather than retried verbatim.

import crypto from "node:crypto";
import fs from "node:fs";

const HOST = "https://openapi.gmgn.ai";

// Leaky bucket is rate=10/capacity=10 by route weight, but the public
// announcement pins the default at 1 req/s. Staying at the announced figure
// keeps us clear of the ban escalation below.
const MIN_INTERVAL_MS = Number(process.env.GMGN_MIN_INTERVAL_MS || 1000);

export class GmgnRateLimitError extends Error {
  constructor(message, resetAtUnix) {
    super(message);
    this.name = "GmgnRateLimitError";
    this.resetAtUnix = resetAtUnix;
  }
}

export class GmgnError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "GmgnError";
    this.code = code;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function detectAlgorithm(pem) {
  const type = crypto.createPrivateKey(pem).asymmetricKeyType;
  if (type === "ed25519") return "Ed25519";
  if (type === "rsa") return "RSA-SHA256";
  throw new Error(`Unsupported GMGN key type: ${type} (want ed25519 or rsa)`);
}

function signMessage(message, pem, algorithm) {
  const buf = Buffer.from(message, "utf-8");
  if (algorithm === "Ed25519") return crypto.sign(null, buf, pem).toString("base64");
  return crypto
    .sign("sha256", buf, {
      key: pem,
      padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
      saltLength: 32,
    })
    .toString("base64");
}

function sortedQueryString(query) {
  return Object.keys(query)
    .sort()
    .flatMap((k) => {
      const ek = encodeURIComponent(k);
      const v = query[k];
      if (Array.isArray(v)) return [...v].sort().map((i) => `${ek}=${encodeURIComponent(i)}`);
      return [`${ek}=${encodeURIComponent(String(v))}`];
    })
    .join("&");
}

function loadPrivateKey() {
  const inline = process.env.GMGN_PRIVATE_KEY;
  if (inline) return inline.includes("\\n") ? inline.replace(/\\n/g, "\n") : inline;
  const path = process.env.GMGN_PRIVATE_KEY_PATH;
  if (path) return fs.readFileSync(path, "utf-8");
  return null;
}

export function createClient() {
  const apiKey = process.env.GMGN_API_KEY;
  if (!apiKey) throw new Error("GMGN_API_KEY missing (get one at https://gmgn.ai/ai)");

  const privateKeyPem = loadPrivateKey();
  const algorithm = privateKeyPem ? detectAlgorithm(privateKeyPem) : null;

  let nextAllowedAt = 0;
  let calls = 0;

  async function throttle() {
    const wait = nextAllowedAt - Date.now();
    if (wait > 0) await sleep(wait);
    nextAllowedAt = Date.now() + MIN_INTERVAL_MS;
  }

  async function request(subPath, query, { signed = false } = {}) {
    // Retrying inside a rate-limit cooldown extends the ban by 5s each time, up
    // to 5 minutes, so a 429 waits out the server's own reset_at and no more.
    for (let attempt = 1; ; attempt++) {
      await throttle();

      const full = { ...query, timestamp: Math.floor(Date.now() / 1000), client_id: crypto.randomUUID() };
      const headers = { "X-APIKEY": apiKey, "Content-Type": "application/json" };

      if (signed) {
        if (!privateKeyPem) {
          throw new Error(
            `${subPath} needs a signature: set GMGN_PRIVATE_KEY_PATH (or GMGN_PRIVATE_KEY) to the private half of the key you uploaded at https://gmgn.ai/ai`
          );
        }
        const message = `${subPath}:${sortedQueryString(full)}::${full.timestamp}`;
        headers["X-Signature"] = signMessage(message, privateKeyPem, algorithm);
      }

      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(full)) {
        if (Array.isArray(v)) for (const i of v) params.append(k, String(i));
        else params.set(k, String(v));
      }

      let res;
      try {
        res = await fetch(`${HOST}${subPath}?${params.toString()}`, { method: "GET", headers });
      } catch (err) {
        if (attempt >= 3) throw new Error(`GET ${subPath} fetch failed: ${err.message}`);
        await sleep(1000 * attempt);
        continue;
      }

      calls++;
      const text = await res.text();

      let body;
      try {
        body = JSON.parse(text);
      } catch {
        if (res.status >= 500 && attempt < 3) {
          await sleep(1000 * attempt);
          continue;
        }
        throw new GmgnError(`GET ${subPath} HTTP ${res.status}: non-JSON response`, res.status);
      }

      if (body.code !== 0) {
        const resetHeader = Number(res.headers.get("x-ratelimit-reset")) || 0;
        const resetAt = body.reset_at || resetHeader || 0;
        if (res.status === 429 || String(body.error || "").startsWith("RATE_LIMIT")) {
          const waitMs = resetAt ? resetAt * 1000 - Date.now() + 1000 : 5000;
          throw new GmgnRateLimitError(
            `${body.error || "RATE_LIMIT"}: cooldown ${Math.max(0, Math.ceil(waitMs / 1000))}s`,
            resetAt
          );
        }
        throw new GmgnError(
          `GET ${subPath} code=${body.code} ${body.error || ""} ${body.message || ""}`.trim(),
          body.code
        );
      }

      return body.data;
    }
  }

  return {
    get callCount() {
      return calls;
    },

    /** Escape hatch for probing routes/params by hand. */
    raw: request,

    /**
     * A wallet's positions, best first. Signed auth, weight 5. Works for any
     * address, not only the ones bound to the API key.
     */
    walletHoldings(chain, wallet, { limit = 50, orderBy = "total_profit", cursor } = {}) {
      const query = {
        chain,
        wallet_address: wallet,
        limit,
        order_by: orderBy,
        direction: "desc",
        // Closed positions are the whole point: a 27x that was fully sold has
        // no balance left and is hidden by the server's defaults.
        hide_closed: "false",
        hide_airdrop: "true",
        hide_abnormal: "false",
      };
      if (cursor) query.cursor = cursor;
      return request("/v1/user/wallet_holdings", query, { signed: true });
    },

    /** Batched wallet stats (winrate, PnL buckets). Weight 3, API key only. */
    walletStats(chain, wallets, period = "30d") {
      return request("/v1/user/wallet_stats", { chain, wallet_address: wallets, period });
    },
  };
}

export const GMGN_CHAIN = { solana: "sol", bsc: "bsc", base: "base" };
