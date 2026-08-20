import "server-only";
import type { NextRequest } from "next/server";
import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";

/**
 * Distributed fixed-window limiter. The previous in-memory implementation was
 * per-instance, so the effective limit on serverless was
 * `configured_limit x instance_count`. Redis makes it one shared budget across
 * every instance.
 *
 * The in-memory buckets below remain as the fallback when Upstash is not
 * configured, so local development and unconfigured deploys keep some
 * protection.
 */
interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();
// Bounds memory if an attacker rotates source addresses.
const MAX_TRACKED_KEYS = 10_000;

function prune(now: number) {
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
  if (buckets.size > MAX_TRACKED_KEYS) {
    const excess = buckets.size - MAX_TRACKED_KEYS;
    let removed = 0;
    for (const key of buckets.keys()) {
      buckets.delete(key);
      if (++removed >= excess) break;
    }
  }
}

export interface RateLimitResult {
  ok: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

function memoryRateLimit(key: string, limit: number, windowMs: number): RateLimitResult {
  const now = Date.now();
  if (buckets.size > MAX_TRACKED_KEYS / 2) prune(now);

  const existing = buckets.get(key);
  if (!existing || existing.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return { ok: true, remaining: limit - 1, retryAfterSeconds: 0 };
  }

  existing.count++;
  if (existing.count > limit) {
    return {
      ok: false,
      remaining: 0,
      retryAfterSeconds: Math.max(1, Math.ceil((existing.resetAt - now) / 1000)),
    };
  }
  return { ok: true, remaining: limit - existing.count, retryAfterSeconds: 0 };
}

let redis: Redis | null | undefined;

function getRedis(): Redis | null {
  if (redis !== undefined) return redis;
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  redis = url && token ? new Redis({ url, token }) : null;
  return redis;
}

// One limiter per (limit, window) pair; the app only uses a handful.
const limiters = new Map<string, Ratelimit>();

function getLimiter(client: Redis, limit: number, windowMs: number): Ratelimit {
  const cacheKey = `${limit}:${windowMs}`;
  let limiter = limiters.get(cacheKey);
  if (!limiter) {
    limiter = new Ratelimit({
      redis: client,
      limiter: Ratelimit.fixedWindow(limit, `${windowMs} ms`),
      prefix: "aw_rl",
    });
    limiters.set(cacheKey, limiter);
  }
  return limiter;
}

export async function rateLimit(
  key: string,
  limit: number,
  windowMs: number
): Promise<RateLimitResult> {
  const client = getRedis();
  if (!client) return memoryRateLimit(key, limit, windowMs);

  try {
    const res = await getLimiter(client, limit, windowMs).limit(key);
    return {
      ok: res.success,
      remaining: res.remaining,
      retryAfterSeconds: res.success ? 0 : Math.max(1, Math.ceil((res.reset - Date.now()) / 1000)),
    };
  } catch (err) {
    // Redis being down must not take the whole site with it.
    console.error("[rateLimit] Upstash unavailable, falling back to memory:", err);
    return memoryRateLimit(key, limit, windowMs);
  }
}

/**
 * A caller can send its own `x-forwarded-for`, and the proxy appends the real IP
 * to the right — so the LEFT-most entry is attacker-chosen and rotating it grants
 * an unlimited fresh bucket. Prefer the headers Vercel sets itself, and take the
 * right-most XFF entry as the last resort.
 */
export function clientIp(request: NextRequest): string {
  const trusted =
    request.headers.get("x-vercel-forwarded-for")?.trim() ||
    request.headers.get("x-real-ip")?.trim();
  if (trusted) return trusted.split(",").pop()?.trim() || "unknown";

  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) {
    const last = forwarded.split(",").pop()?.trim();
    if (last) return last;
  }
  return "unknown";
}
