import { isAdminConfigured, isAdminRequest } from "@/lib/adminAuth";
import { fetchAdminStats } from "@/lib/db/adminStats";
import {
  fetchAlertCuts,
  fetchAlertSuppression,
  fetchCallCards,
  fetchCallScore,
  fetchTierScoreboard,
} from "@/lib/db/alerts";
import AdminLogin from "@/components/admin/AdminLogin";
import AdminDashboard from "@/components/admin/AdminDashboard";

// Never cached and never indexed: this page renders live revenue data.
export const dynamic = "force-dynamic";
export const metadata = { title: "Admin", robots: { index: false, follow: false } };

export default async function AdminPage() {
  if (!isAdminConfigured()) {
    return (
      <main className="mx-auto max-w-md px-6 py-24 text-sm text-neutral-400">
        <h1 className="mb-3 text-lg font-semibold text-neutral-100">Admin disabled</h1>
        <p>
          Set <code className="text-amber-300">ADMIN_PASSWORD</code> in the Vercel project
          environment variables and redeploy to enable this page.
        </p>
      </main>
    );
  }

  if (!(await isAdminRequest())) return <AdminLogin />;

  const stats = await fetchAdminStats();
  if (!stats) {
    return (
      <main className="mx-auto max-w-md px-6 py-24 text-sm text-neutral-400">
        No database configured, so there is nothing to report.
      </main>
    );
  }

  // Sequential, never Promise.all — see AGENTS.md. Five statements now, which
  // is why each one does all of its grouping in a single pass instead of a
  // query per dimension.
  const alertScores = await fetchTierScoreboard("solana");
  const callScore = await fetchCallScore("solana");
  const alertCuts = await fetchAlertCuts("solana");
  const alertSuppression = await fetchAlertSuppression("solana");
  const callCards = await fetchCallCards("solana");

  return (
    <AdminDashboard
      initial={stats}
      alertScores={alertScores}
      callScore={callScore}
      alertCuts={alertCuts}
      alertSuppression={alertSuppression}
      callCards={callCards}
    />
  );
}
