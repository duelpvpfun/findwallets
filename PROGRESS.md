# Hardening pass — progress & handoff

Working against the P0/P1/P2 task list for `duelpvpfun/findwallets`.

**Status: shipped.** Merged to `main` via PR #1 (merge commit `83dae51`) and
deployed to production on 2026-08-20. Verified live — see "Confirmed in
production" below. `main` is in sync with `origin/main`.

Verification command (cached, ~5s warm):

```bash
npm run check     # tsc --noEmit + eslint --cache, prints TSC=/LINT=
```

Current state: `TSC=0 LINT=0`, 2 known warnings (React Compiler skipping
`useVirtualizer` in `TradersTable.tsx` — expected, TanStack Virtual is on the
compiler's incompatible-library list).

---

## The bug the customer actually hit

Two separate faults, both now fixed:

1. **`/admin` and the stats cron hung forever.** `postgres.js` pipelines
   concurrent queries onto its pooled connections, and when a fan-out outruns
   the pool, Supabase's transaction pooler stops answering — the queries never
   resolve and the request hangs until the platform kills it. `fetchAdminStats`
   fired 11 queries as concurrent batches against a pool of **one**, so
   `refresh-stats` took **10 minutes** before the fix and **0.3s** after it.
   Reproduced in isolation against the live database: 4 concurrent queries on
   `max: 1` never returned; the same 4 on `max: 2` finished in 162ms.
   *Note this was made certain by item 2 of the task list (`max: 5` → `max: 1`),
   which was never deployed — it would have taken the whole site down.*
2. **A buyer whose scan died was told their purchase was "already used"** for
   the next ten minutes, and on reload the client deleted their claim token from
   `localStorage` because `/api/claim` reported it invalid. They were left at the
   paywall holding a purchase they could no longer name.

---

## Done (committed)

| # | Item | Commit |
|---|------|--------|
| 2 | Pool sizing + pooled-URL note in `.env.local.example` | `defd44c`, corrected in `7aa15b3` |
| 3 | `fetchTopTraders` `MAX_PAGES = 10` + deadline + empty-page break | `ccde8c6` |
| 1, 4 | `maxDuration = 300` / `force-dynamic`, wall-clock budget, `waitUntil(persistScan)`, `scan_credits.reserved_at` + cron sweeper, scoped `releaseCredit` returning a boolean | `f319734` |
| 5 | One list mounted, `React.memo` rows/cards, stable `useCallback` handlers, isolated `<CopyJsonButton>`, `@tanstack/react-virtual` above 100 rows, rAF yield before the JSON build | `585bbdb` |
| 6, 7 | `stats_snapshot` + cron refresh, `pg_class` row estimates, 30d windows; `fetchWalletHistories` as a lateral top-5 with a covering index | `19205b0` |
| 8, 9 | Last scan in `sessionStorage`; `tokens.estimated_supply` read server-side | `11680e5` |
| 10 | `@upstash/ratelimit` behind the same (now **async**) `rateLimit()` signature | `007da52` |
| 11 | `@sentry/nextjs` server/client/edge with secret scrubbing and scan tags | `da0ae5f` |
| 12, 13 | `error.tsx`, `global-error.tsx`, `not-found.tsx`; `/api/pay/recover` + `/recover` | `eeef222` |
| — | Enhancements: CSV + address-list export, NDJSON streaming, metadata/OG/robots/sitemap, skeleton, `/` `a` `c` shortcuts | `76959db` |
| — | **Pool `max: 3`, all 11 admin queries sequential, serial usage flush, `reltuples` clamped at 0** | `7aa15b3` |
| — | **Stale-reservation takeover after 2 min, `credit_pending` reason, client keeps the token while a reservation is held** | `39b4d17` |
| — | **`SCAN_BUDGET_MS` 45s → 180s, honest partial-banner copy** | `2279a88` |
| — | `MIGRATION.md` | `8107dba` |
| — | `scripts/credit-lifecycle.mjs` | `6d03837` |

### Verified at runtime (live Supabase + real provider keys)

- `scripts/credit-lifecycle.mjs`: 13/13 checks pass — reserve → deliver clears
  `reserved_at`; retry inside 2 min → 402 `credit_pending`; retry after a
  3-minute-old reservation takes it over and delivers; a 15-minute-old
  reservation is released by the sweeper; a delivered credit stays spent.
- Solana **Top 500**: 500 traders, `partial: false`, 239 histories, **4.3s**.
- BSC Top 100 streamed: `token` → `progress 60/100` → `progress 83/100` →
  `result traders=83 partial=false session=true`, 5.0s. (83 is all upstream had;
  `partial` correctly stays false when the clock is not what stopped us.)
- `/api/cron/refresh-stats`: **0.31s cold, 0.14s warm**, `{"refreshed":true}`;
  401 without the bearer.
- `/api/cron/release-stale-credits`: `{"released":1}` on a planted stale row.
- `stats_snapshot` read: **6–7ms** warm, 29KB payload — this is all
  `/api/admin/stats` does once the cron has run.
- All three migrations confirmed present in the live database.

---

## Confirmed in production (2026-08-20, after the merge)

Probed against `https://www.alphawallets.fun` with no secrets:

| Check | Result |
|---|---|
| Home, `/recover`, `/admin` | 200 (admin 0.97s) |
| Unknown path | 404 — the app's own page |
| `/api/cron/*` without a bearer | 401 |
| `/api/admin/stats` without a session | 401 |
| Scan with no credit | 402 |
| `robots.txt`, `sitemap.xml`, `opengraph-image` | 200, all on `www.alphawallets.fun` |
| `/api/pay/recover?signature=nope` | 400 |

**The Vercel crons are firing.** `stats_snapshot.generated_at` was 14s old when
checked, which also proves `CRON_SECRET` is set correctly in Vercel — so the
credit sweeper is running too. `scan_credits`: 40 rows, **0 reserved, 0 stale**.

Environment variables confirmed set in Vercel: `CRON_SECRET`, `ADMIN_PASSWORD`,
`NEXT_PUBLIC_SITE_URL` (`https://www.alphawallets.fun/` — the trailing slash is
harmless, `new URL()` normalises it).

## Still open

1. **Upstash and Sentry are not configured** — skipped deliberately at deploy.
   Both are optional and the site runs fine without them: rate limiting falls
   back to per-instance memory (how it behaved before this pass), and there is no
   error reporting. The owner asked to be reminded from **2026-08-21**.
   `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`,
   `NEXT_PUBLIC_SENTRY_DSN` (+ `SENTRY_ORG`/`SENTRY_PROJECT`/`SENTRY_AUTH_TOKEN`).
2. **Mobile "Copy JSON" at Top 500 was never profiled.** The fix is in — one list
   mounted, memoized rows, virtualization above 100 rows, isolated copy state —
   but no browser automation was available. Needs: one checkbox toggle re-renders
   one row; Copy JSON produces no long task over 200ms on a 4x-throttled CPU.
3. **`npm run build` cannot complete in this dev container.** It is SIGTERMed a
   few seconds into the compile stage — VS Code holds ~5.4GB of the 8GB — and
   dies before reaching any project file. This is not a code fault: use
   `npm run check` as the local gate and a Vercel preview build as the real one.

### How to ship from here

Push to a branch, open a PR, let the owner test the Vercel preview, then merge.
He does not want anything going straight to `main` — production takes real money.
On a preview, cron jobs do **not** run (production only), the database is the
**live** one, and env vars must be ticked for Preview as well as Production.
Free scans on a preview: visit `<preview-url>/?key=$OWNER_ACCESS_KEY` once.

See `MIGRATION.md` for the full env var list with consequences.

---

## Notes for whoever picks this up

- **Never `Promise.all` database calls.** See the rule in `AGENTS.md`. A fan-out
  wider than the pool hangs rather than queueing.
- **If `next dev` 404s every route, `rm -rf .next`** — a leftover production
  build in the same directory does that.
- `rateLimit()` is `async`. Any new route must await it.
- Streaming is opt-in via `?stream=1`; without it the route returns the same
  plain JSON object.
- `releaseCredit(claimToken, chain, tokenAddress)` returns a boolean and refuses
  to release a reservation that doesn't match, logging when it no-ops.
- A credit counts as delivered only once `confirmCreditDelivered` clears
  `reserved_at`. Anything still holding `reserved_at` after 2 minutes may be
  retaken by its own owner, and after 10 minutes is swept.
- A partial scan **keeps** the credit spent — deliberate, per the owner. The
  banner says so plainly and links to `/recover`.
- `perf2.mjs` in the repo root is untracked and was deliberately left alone.
- **Careless `>>` into `.env.local` corrupted two lines in an earlier session**
  (the file has no trailing newline). Edit it with a real editor.
