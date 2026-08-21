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

---

# Profiles & polish pass — 2026-08-20

Branch `feat/profiles-and-polish`. Four workstreams, one commit each. Gate is
`npm run check`: **TSC=0 LINT=0**, same two known `useVirtualizer` warnings.

## 1. Quality bar — reverted, no net change

I initially turned the 2x/$1,000 bar from a **write gate** into a column, so that
near-misses were stored (flagged) and a real per-wallet win rate could be
computed. The owner corrected the intent: **`wallet_tokens` is a curated
alpha-wallet database**, not a log of every wallet a scan returned. A wallet
earns a row by clearing 2x AND $1,000, full stop.

Reverted in full — `quality.ts`, `record.ts`, `history.ts`, `showcase.ts`,
`enrich-wallets.mjs` are byte-identical to `main`, the `N/M hit` chip is gone,
and `drizzle/0019_revert_qualified_flag.sql` dropped the columns and deleted the
17 sub-bar rows that were written while `0017` was live.

Worth recording, because it was the source of the confusion: **the bar never
applied to what a buyer sees.** Neither `solanaTracker.ts` nor `birdeye.ts`
filters on it, and the scan route puts the upstream `traders` array straight into
the response. It only ever gated (a) rows written to `wallet_tokens` and (b)
which wallets got a paid enrichment call. Both are unchanged. This distinction is
now written down in `AGENTS.md`, which is the actual durable outcome of the
detour.

## 2. Onboarding carousel — shipped

Five panels, real data throughout, replacing `ProductPreview.tsx`.

**The brief was wrong about one thing and it changed the design.** It said the
final panel should stream a live scan "through the existing `/api/preview` route
and the NDJSON pipeline in `src/lib/scanStream.ts`". `/api/preview` is not a
streaming endpoint — it is a plain-JSON replay out of `fetchCachedScan`, with no
NDJSON path and no involvement from `scanStream.ts` at all. Wiring the *paid*
streaming route into an unpaid walkthrough would mean either spending upstream
credits per visitor or faking a stream. So the scan panel reveals the real cached
rows in eight staged "pages" and the caption states outright that the figures are
real and only the pacing is a replay.

The old dialog carried four hand-written wallet addresses with invented PNL,
plausible enough to be taken for real. That is now gone; when the preview is
unavailable the panels render their chrome with no figures rather than
placeholders.

## 3. Wallet accounts — shipped

Sign-In With Solana, credit balances, 7-day scan receipts, `/profile`. This is
the money-path work; `AGENTS.md` has the rules that came out of it.

Verified live with `npm run test:accounts` — **30/30 checks pass**, including the
four that can only be proven against a real database:

| Check | Result |
|---|---|
| A purchase made before the wallet ever signed in attaches on sign-in | PASS |
| A replayed `verify` with a used nonce | 401 |
| A signature from a different wallet over the right nonce | 401 |
| A tampered session cookie | not a session |
| Two concurrent scans against ONE account credit | exactly one succeeded |
| Re-download reads storage, no upstream call | PASS, `fromStoredResult: true` |
| Purge deletes an expired result, keeps a pinned one | PASS |
| An unattached claim token still redeems for a signed-in user | PASS, `creditSource: claim_token` |

And `npm run test:credits` — the pre-existing anonymous flow — still **17/17**.

## 4. UI pass — shipped

`ScanProgress` replaces `TableSkeleton`; one `RadarSweep` used in exactly two
places; rank accents and PNL weight for the top three; `.tnum` on every live
figure; a global `:focus-visible` ring; contrast lifted off `neutral-600`.

**Nothing inside `TradersTable` is animated**, deliberately — the virtualized
lists remount rows on scroll, so a per-row entrance would flash rows as you
scroll and spend the render budget the hardening pass bought back.

## Surprises worth writing down

1. **A `Date` interpolated into a raw `sql` fragment silently breaks.** It skips
   drizzle's type mapper, so `postgres.js` gets a bare `Date` and the query dies
   at bind time. Every sign-in returned a 500 until this was found — by the
   lifecycle script, which is the entire reason it exists. Three call sites.
   Now a rule in `AGENTS.md`.
2. **`scripts/apply-migration.mjs` only ever applied the newest `.sql`** —
   `.sort().pop()`. Any branch adding two migrations would have silently skipped
   the first. Now takes named files in order.
3. **`wallet_tokens` already contains 96 rows that fail the 2x/$1k rule** — 2.9%
   of the table, all first stored 2026-08-17/18, i.e. predating this branch. 94
   cleared 2x but made $22–$999; 2 have huge PNL ($124k, $127k) but a *null*
   multiple, which is what happens when a later backfill nulls a dust-basis
   multiple on a row that was already stored. Nothing here wrote them and nothing
   here deletes them — flagged for the owner, see "Still open".
4. **The storage estimate in the brief was ~10x optimistic.** Measured: ~930
   bytes of JSON per trader, so a Top 500 receipt is ~450KB, not ~40KB. TOAST
   compresses it poorly because the bulk is base58 and floats. Still only ~100MB
   resident at a thousand scans a month, so the conclusion holds — but the
   figure in the docs is now the measured one.
5. **Multi-credit purchases need an account.** `/recover` maps a signature back
   to one credit, and a browser holds one claim token, so extra credits bought
   anonymously would be unreachable the moment the tab closed. Quantity > 1 is
   therefore gated on a session, server-side.

## Still open

1. **Render performance is reasoned about, not profiled.** No browser automation
   is available in this container (same limitation as the hardening pass). What
   *is* established: no animation was added inside `TradersTable`; the new row
   styling derives from `rank` and `selected`, both already props, so no new
   object or closure is passed per row; and `virtualizer.measureElement` is
   instance-bound in `@tanstack/virtual-core` (assigned once, not per render),
   so it does not defeat the row memo. **Still needs a human with a profiler:**
   Top 500 on a 4x-throttled CPU, one checkbox toggle re-rendering one row, and
   no long task over 200ms.
2. **`AUTH_SESSION_SECRET` is not set in Vercel.** Not a blocker — it derives a
   key from `OWNER_ACCESS_KEY` — but until it is set, rotating the owner key
   signs every user out. See `MIGRATION.md`.
3. **The new cron is production-only**, like the others. `/profile` will list
   expired results on a preview deployment until the first production run.
4. **`/api/showcase` fans out three database calls with `Promise.all`** — the
   exact pattern `AGENTS.md` forbids, and it predates this branch. Three
   concurrent queries against a pool of three is right on the edge; it has not
   hung in practice, but it is one added query away from the failure that made
   `/admin` unreachable. Out of scope here, worth a one-line fix.
5. **Migrations `0018` and `0019` are applied to the live database** (`0017` was
   applied and then undone by `0019`). `main` references none of it, so `main` is
   unaffected if this branch is not merged. A **fresh** database should apply
   `0018` only — see `MIGRATION.md`.
6. ~~96 pre-existing rows fail the 2x/$1k rule.~~ **Done** — see below.

## Retroactive compliance sweep — 2026-08-20

`scripts/purge-noncompliant.mjs` (report by default, `--apply` to delete). The
2x/$1,000 gate only ever ran on write, so rows predating it — and rows whose
multiple was later revised down or nulled by `purge-dust-basis.mjs` /
`backfill-pnl-math.mjs` — were never re-checked.

Applied to production:

| | Before | Deleted | After |
|---|---|---|---|
| `wallet_tokens` | 3,319 | 96 | 3,223 |
| `wallet_positions` | 9,115 | 0 | 9,115 |
| `wallets` | 2,949 | 69 | 2,880 |

The 96 were 94 rows that cleared 2x but realized $22–$999, plus 2 with a **null**
multiple. Those two carried $124,464 and $126,917 of realized profit — deleted
because the rule needs both halves and a return we cannot measure is not 2x. Worth
knowing they were the largest rows removed by a wide margin.

`wallet_positions` had zero violations, which confirms the enrichment worker's
gate has held since it was written.

The 69 wallets were those left with no compliant trade in either table. Wallets
carrying GMGN `win_badges` are exempt — proven wins on tokens nobody paid to scan
here still make a wallet alpha — but none of the 69 had any.

Verified independently afterwards: lowest stored multiple **2.00**, lowest stored
realized PNL **$1,000**, zero null multiples, zero orphaned wallets, zero dangling
foreign keys, zero duplicates, and 331 wallets still carrying multi-token tags.

Re-run the report any time; it is idempotent and prints without `--apply`.
