"use client";

import { useState } from "react";

export default function AdminLogin() {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body.error ?? "Login failed.");
        return;
      }
      // Full reload so the server component re-renders with the new cookie.
      window.location.reload();
    } catch {
      setError("Network error.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center px-6 py-24">
      <h1 className="mb-1 text-lg font-semibold text-neutral-100">Admin</h1>
      <p className="mb-6 text-xs text-neutral-500">Private dashboard.</p>
      <form onSubmit={submit} className="space-y-3">
        <input
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Password"
          className="w-full rounded-lg border border-neutral-800 bg-neutral-900 px-3 py-2 text-sm text-neutral-100 outline-none placeholder:text-neutral-600 focus:border-neutral-600"
        />
        <button
          type="submit"
          disabled={busy || password.length === 0}
          className="w-full rounded-lg bg-neutral-100 px-3 py-2 text-sm font-medium text-neutral-950 transition disabled:opacity-40"
        >
          {busy ? "Checking…" : "Sign in"}
        </button>
        {error ? <p className="text-xs text-red-400">{error}</p> : null}
      </form>
    </main>
  );
}
