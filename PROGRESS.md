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


# Live polish + EVM accounts — 2026-08-21

Two things happened this day. Everything in section 1 is **merged to `main` and
verified in production**. Section 2 is **PR #3, open and unmerged**.

## 1. Shipped (PR #2, merge commit `736b899`, then `02c8650` on main)

The accounts/onboarding/UI branch went out, followed by two rounds of the owner's
own feedback from the preview. In the order it will matter to whoever picks this up:

- **Admin payments table** now flags a first-time buyer with a gold `NEW` badge and
  shows a lifetime purchase count per payer (`1-4 / 5-9 / 10-19 / 20-49 / 50+`,
  hue climbing). Both come from one `buyers` CTE in `adminStats.ts` that aggregates
  the **whole table**, not the 100 rows on the page, so neither is confused by the
  `limit`. Purchases are counted **per signature** (`split_part(payment_id,'#',1)`),
  because a bulk order mints one row per credit and that is one purchase.
- **Row numbers follow the list, not the provider.** `#1` is the top row on screen.
  The renumbering happens in `filteredTraders` where the order is decided, so the
  number, the top-three accent and a rank-named export all agree. Rows already
  numbered correctly keep their object identity, which preserves the row memo. The
  medal accent is suppressed while sorted ascending, or last place gets a gold bar.
  **The wallets in a scan are still *selected* upstream by realized PNL** — both
  providers only rank on realized — so switching the PNL basis re-ranks that set
  rather than fetching a different one. That caveat lives in the toggle's tooltip.
- **New filters:** average entry market cap and total USD bought, both in
  thousands. Entry filters on market cap whatever the Mcap/Price toggle shows.
  The "Why Avg X isn't Exit ÷ Entry" disclosure is gone; the same text is still on
  the column header and every Avg X cell as a tooltip.
- **The walkthrough** is a fixed height (five panels of five sizes under an
  auto-advance threw the dialog around the screen), holds each panel **5s**, and
  has "Don't show this again" **unchecked by default** — ticking it is the only
  thing that suppresses it, and then it never returns.
- **Free sample scans are paced** through the real scan panel. A cached sample
  returns in one response, so the panel used to flash for a single frame and the
  free run felt like nothing happened. Abandoned via a run counter if the visitor
  hits Back or starts a real scan; skipped entirely under reduced motion.
- **The wallet dropdown was opening behind the hero heading.** `backdrop-blur` on
  the header makes it a stacking context, so the dropdown's own `z-50` only ever
  applied inside it. The header is `z-40` now, under every modal.
- **`/profile` is reachable**: a header link (only once a wallet is connected) and
  a back arrow in the page header. "Total spent" removed from the balance strip.
- **The wallet approval prompt is branded**: the signed message leads with
  `alphawallets.fun`, and a 180px `apple-icon` was added because wallets show the
  largest site icon they can find and the 64px favicon rendered soft.
- **Customer-facing copy was rewritten** across the walkthrough, paywall, profile,
  sign-in prompt, partial-scan banner, recover page and tooltips. See the style
  rule this produced in `AGENTS.md`.

Verified live after the merge: all pages 200, `/api/admin/stats` 401,
`/apple-icon` 200, no Profile link in signed-out HTML, `/api/auth/nonce` returning
the branded message, and the 5s auto-advance present in the production bundle
(`setTimeout(...,5e3)`).

## 2. Open: EVM accounts (PR #3, branch `feat/evm-accounts`)

Sign-in was Ed25519-only, so anyone arriving with MetaMask and no Solana wallet
could not have an account — and without an account a purchase lives and dies with
their localStorage, which is the exact bug accounts were built to fix. Since the
tool ranks BNB Chain and Base too, that is a large share of customers.

Either family now signs in, chosen by address format. Solana keeps `signMessage`
and Ed25519; EVM uses `personal_sign` and is verified by **secp256k1 recovery**,
because an EVM address is a hash of a public key and there is nothing to compare
directly. Details and the traps are in `AGENTS.md` under Accounts.

- `npm run test:accounts` passes end to end, with four new steps (EVM sign-in, a
  checksummed address resolving to the **same** account, `wallet_chain` recorded,
  a signature from a different key refused).
- Migration `0020` (`users.wallet_chain`) is **already applied to the live
  database**. Additive with a default, so `main` is unaffected if this is not merged.
- `@noble/curves` and `@noble/hashes` became **direct** dependencies. Already in
  the tree via `@solana/web3.js`; pinned so a lockfile change cannot remove
  something the auth path calls.
- **Known rough edge:** an EVM account gets no retroactive backfill, because
  payment is in SOL/USDC so `payer_wallet` is always base58. It fills from
  purchases made while signed in, and `/profile` says so. The real fix is
  **linking a second wallet to one account**, which is the obvious next task here.
- Not built: EIP-1271 smart-contract wallets. No key to recover, and a Safe cannot
  pay in SOL.

## Growth shortlist (owner asked, 2026-08-21)

$250 in the first two days, ~50-80 scans, average order ~$3.50. The two numbers
that matter: **AOV is tiny** and **every dollar needs a fresh wallet round-trip**.
The moat is `wallet_tokens` (~2,880 curated wallets), not the scanner.

Ranked by return per hour of work:

1. **Bundles at checkout** — 10 scans for $19. `createCredits` already mints
   multi-scan purchases and accounts already hold spares, so this is pricing and
   UI only. Moves AOV from $3.50 toward $19.
2. **"Is smart money already in this token?"** — reverse the query: paste a CA,
   get how many curated wallets hold it now. Free, instant, no upstream credits,
   and it answers the question people have *before* paying.
3. **A public track record** — take wallets flagged 30 days ago and show what they
   did after. Trust is what caps conversion at $6, and only we can compute it.
4. Alerts as a subscription (Helius webhooks + worker): "3+ of your tracked
   wallets just bought the same token". The scan is how they find wallets; the
   watching is the product. Biggest build, changes the ceiling.
5. Rescan diffing — who sold, who added, who is new since your last scan.
6. Cross-token alpha leaderboard, free teaser + subscription.
7. Sharper labels (snipers, bundlers, deployer-funded) to justify a premium tier.
8. Free daily "alpha radar" post/feed as top-of-funnel, runs on our own data.
9. Referral credits and KOL codes. Accounts + `payer_wallet` make attribution cheap.
10. Export presets for Photon / BullX / Axiom / GMGN / Trojan.

## Still open

1. **Top 500 on a real phone is still unprofiled.** Same gap as the hardening
   pass: no browser automation in this container, so every layout and render claim
   on these branches is reasoned, not measured. The one to check is Top 500 plus
   Copy JSON on a phone.
2. **Upstash and Sentry are still unset in Vercel.** Rate limiting falls back to
   per-instance memory (so the real limit is `configured × instances`) and paid
   scan failures are invisible. Both free signups. Ideas 4 and 8 above would make
   both mandatory rather than optional.
3. **`AUTH_SESSION_SECRET` is still unset.** It derives from `OWNER_ACCESS_KEY`,
   so rotating the owner key signs every user out.
4. **`/api/showcase` still fans out three `Promise.all` database calls** — the
   pattern `AGENTS.md` forbids. Predates all of this; three concurrent queries on
   a pool of three is right at the edge. One-line fix, never done.
