import type { Metadata } from "next";
import { getSessionUser } from "@/lib/auth/session";
import { fetchCreditBalance, fetchUserPurchases } from "@/lib/db/credits";
import { fetchUserScanResults, MAX_PINNED, RETENTION_DAYS } from "@/lib/db/scanResults";
import { isDbConfigured } from "@/lib/db";
import { TIER_OPTIONS } from "@/lib/tiers";
import ProfileClient from "@/components/profile/ProfileClient";
import SignInPrompt from "@/components/profile/SignInPrompt";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Your purchases",
  description: "Credit balance, purchase history and saved scan results.",
  robots: { index: false, follow: false },
};

/**
 * The account page. Server-rendered so the session is read from the cookie
 * rather than trusted from the client, and so a reload never shows an empty
 * shell while a fetch resolves.
 *
 * Every query below runs one after another. A `Promise.all` of database calls is
 * a latent hang here: postgres.js pipelines onto a pool of 3, and a fan-out
 * wider than the pool stops Supabase's transaction pooler answering at all.
 * This is what made /admin unreachable — see AGENTS.md.
 */
export default async function ProfilePage() {
  const session = await getSessionUser();

  if (!session || !isDbConfigured()) {
    return <SignInPrompt configured={isDbConfigured()} />;
  }

  const balance = await fetchCreditBalance(session.id);
  const purchases = await fetchUserPurchases(session.id);
  const results = await fetchUserScanResults(session.id);

  return (
    <ProfileClient
      wallet={session.wallet}
      balance={balance}
      purchases={purchases.map((p) => ({
        paymentId: p.paymentId,
        method: p.method,
        tier: p.tier,
        priceUsd: TIER_OPTIONS.find((t) => t.limit === p.tier)?.priceUsd ?? null,
        createdAt: p.createdAt.toISOString(),
        consumedAt: p.consumedAt ? p.consumedAt.toISOString() : null,
        consumedChain: p.consumedChain,
        consumedTokenAddress: p.consumedTokenAddress,
        consumedTokenSymbol: p.consumedTokenSymbol,
      }))}
      results={results.map((r) => ({
        id: r.id,
        chain: r.chain,
        tokenAddress: r.tokenAddress,
        tokenSymbol: r.tokenSymbol,
        traderCount: r.traderCount,
        requestedCount: r.requestedCount,
        pinned: r.pinned,
        createdAt: r.createdAt.toISOString(),
        expiresAt: r.expiresAt.toISOString(),
      }))}
      retentionDays={RETENTION_DAYS}
      maxPinned={MAX_PINNED}
    />
  );
}
