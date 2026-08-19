import "server-only";
import { createHash } from "node:crypto";
import { getDb } from "./index";
import { siteVisits } from "./schema";

/**
 * Visitor identity for counting only. The raw IP is never stored: it is hashed
 * together with the user agent and a server secret, so the table can distinguish
 * visitors without holding data that identifies them.
 */
export function visitorHash(ip: string, userAgent: string): string {
  const salt = process.env.OWNER_ACCESS_KEY ?? "findwallets";
  return createHash("sha256").update(`${salt}|${ip}|${userAgent}`).digest("hex").slice(0, 32);
}

export interface VisitInput {
  path: string;
  referrer: string | null;
  country: string | null;
  ip: string;
  userAgent: string;
}

/** Best-effort; a failed analytics write must never break a page load. */
export async function recordVisit(input: VisitInput): Promise<void> {
  const db = getDb();
  if (!db) return;
  try {
    await db.insert(siteVisits).values({
      path: input.path.slice(0, 200),
      referrer: input.referrer?.slice(0, 300) ?? null,
      country: input.country?.slice(0, 8) ?? null,
      visitorHash: visitorHash(input.ip, input.userAgent),
      userAgent: input.userAgent.slice(0, 300) || null,
    });
  } catch {
    // ignored
  }
}
