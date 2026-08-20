<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Alpha Wallet Finder (findwallets)

Paste a Solana / BNB Chain / Base token contract address, get its top 100–500 traders ranked by
realized PNL, export them as JSON for a tracking bot. **Users pay real money in SOL/USDC per scan.**

Deployed on Vercel. Live at findwallets.vercel.app.

## Stack

- Next.js 16 (App Router), React 19, TypeScript, Tailwind v4
- Drizzle ORM + `postgres.js` against Supabase Postgres (us-east-1)
- Upstream data: Solana Tracker (Solana), Birdeye (BSC/Base), Helius (payment verification)
- No test framework is set up. Verify with `npx tsc --noEmit` and `npm run lint`.

## Commands

```bash
npm run dev              # local dev server
npm run build            # production build
npm run lint             # eslint
npx tsc --noEmit         # typecheck — the main correctness gate
npm run db:push          # apply Drizzle schema changes
npm run db:studio        # browse the database
npm run enrich           # wallet enrichment worker (manual, long-running)
npm run enrich:stats     # enrichment progress
# paid-credit lifecycle (needs a running dev server; creates its own test credit):
#   env -u DATABASE_URL node --env-file=.env.local scripts/credit-lifecycle.mjs
```

Typecheck and lint are slow on small machines. Run them at the end of a work session, not after
every edit, unless asked.

## Rules that will bite you

**Two different database URLs.** `DATABASE_URL` / `POSTGRES_URL` must be the Supabase **transaction
pooler** string (port 6543, `pooler.supabase.com`) — the app runs on serverless and would otherwise
exhaust connections. `POSTGRES_URL_NON_POOLING` is the direct connection and is only for migrations.
Never swap them. `src/lib/db/index.ts` sets `prepare: false` because the pooler doesn't support
prepared statements.

**If `next dev` returns 404 for every route, delete `.next`.** A production build left in the same
directory does this — the server starts, reports "Ready", compiles the route on request, and then
404s the whole app. `rm -rf .next` and restart.

**Never fan out concurrent database queries.** `postgres.js` pipelines queries onto its pooled
connections, and when a fan-out outruns the pool, Supabase's transaction pooler stops answering
entirely — the queries never resolve and the request hangs until the platform kills it. Measured
against the live database: 4 concurrent queries on a pool of 1 never returned; 11 on a pool of 3
never returned; the same queries run one after another finish in milliseconds. `src/lib/db/index.ts`
sets `max: 3`, so **a `Promise.all` of database calls is a latent hang, not a speed-up**. Await them
in sequence. This is what made `/admin` unreachable.

**`scripts/*.mjs` cannot import from `src/lib`.** Everything under `src/lib` is behind the
`server-only` boundary. Three things are duplicated because of it, and each has to be changed in
both places:

| In `src/lib` | Duplicated in | Drift shows up as |
|---|---|---|
| `MIN_WALLET_MULTIPLE_X`, `MIN_WALLET_PNL_USD` (`quality.ts`) | `scripts/enrich-wallets.mjs` | The worker and the app disagree about what counts as a win |
| `formatWinBadge` (`format.ts`) | `scripts/enrich-wallets.mjs` | Badges rendered two different ways |
| `buildSignInMessage` (`auth/message.ts`) | `scripts/account-lifecycle.mjs` | Step B of that script fails loudly — which is the point |

**A `Date` interpolated into a raw `sql` fragment does not work.** `sql\`${col} > ${aDate}\`` skips
drizzle's type mapper, so `postgres.js` is handed a bare `Date` and the query dies at bind time with
`ERR_INVALID_ARG_TYPE`. Use the typed helpers (`gt`, `gte`, `lt`) against the column, or — inside a
hand-written statement where there is no column to take a mapper from — bind
`date.toISOString()` with an explicit `::timestamptz`. This made every sign-in return a 500.

**Anything touching money needs care.** These files decide whether a paying user gets what they paid
for:

- `src/lib/access.ts` — resolves entitlement per request
- `src/lib/db/credits.ts` — reserve / release / create credits, and account balances
- `src/lib/db/users.ts` — sign-in nonces and the retroactive purchase backfill
- `src/app/api/pay/init/route.ts` and `pay/confirm/route.ts` — quoting and on-chain verification
- `src/lib/solanaPay.ts` — transaction building and signature verification
- `src/lib/auth/*` — sign-in message, Ed25519 verification, session cookie

Do not change the semantics of these without flagging it first. In particular:

- `reserveCredit` uses a single atomic `UPDATE ... WHERE consumed_at IS NULL ... RETURNING`. This is
  what stops two concurrent scans sharing one purchase. **Never refactor it into a read-then-write.**
  `reserveUserCredit` is the same pattern applied to an account's whole balance: the inner `SELECT`
  picks a candidate under `FOR UPDATE SKIP LOCKED` and the outer `UPDATE` re-asserts
  `consumed_at IS NULL`. Both halves are load-bearing.
- **`createCredits` mints one row per credit for a multi-scan purchase.** The first keeps the bare
  transaction signature as its `payment_id`; the rest are `<sig>#1`, `<sig>#2`. The unique index on
  `payment_id` is what makes a replayed confirm a no-op instead of a way to mint credits, so that
  scheme must stay stable. `findCreditByPaymentId` (and therefore `/recover`) only ever finds the
  first — which is why buying more than one **requires a signed-in account**, since the spares would
  otherwise be unreachable.
- **The client must not assume its claim token was the one spent.** `resolveAccess` tries the account
  balance first, so a localStorage claim token can be completely untouched after a successful paid
  scan. The response carries `creditSource: "account" | "claim_token"`; clearing localStorage on
  anything else destroys a paid purchase.
- The credit is consumed **before** the scan runs, so any path where the scan dies without calling
  the release path costs a buyer their purchase.
- Payment confirmation is verified server-side against chain data. Never trust a browser-reported
  success.

**Entitlement is enforced server-side only.** The client can ask for 500 wallets; `resolveAccess`
decides what it actually gets. Never move a gate into the browser.

**Credentials travel in headers, not query strings** (`x-claim-token`, `x-owner-key`) so they stay
out of access logs and Referer headers. Keep it that way.

## Accounts

Wallet sign-in is **additive and never required**. Nobody has to sign in to scan or to pay, and the
anonymous claim-token flow is unchanged. Do not let that slip.

- **Sign-In With Solana, not a transaction.** `/api/auth/nonce` issues a single-use challenge;
  the client calls `provider.signMessage(...)`. **Never `signAndSendTransaction`** — signing in must
  cost zero lamports.
- **The signed message is rebuilt server-side** from the stored nonce (`buildSignInMessage`). Never
  verify against a message body the client supplied, or a caller can have a wallet sign anything at
  all and present it as a sign-in.
- The nonce is claimed by an atomic `UPDATE ... WHERE used_at IS NULL` **before** the signature is
  checked, so a wrong guess burns the challenge rather than allowing another attempt.
- Ed25519 verification uses `node:crypto` (a raw 32-byte key wrapped in the fixed Ed25519 SPKI DER
  prefix), not `tweetnacl`. `bs58` is a direct dependency for decoding the 64-byte signature.
- The session is an HMAC cookie (`aw_user`), same pattern as `src/lib/adminAuth.ts`, signed with
  `AUTH_SESSION_SECRET` or a value derived from `OWNER_ACCESS_KEY`. 30-day TTL, sliding: `/api/auth/me`
  re-issues it once it is inside five days of expiring.
- **The backfill is the whole point.** `scan_credits.payer_wallet` is populated on every confirmed
  payment, so `upsertUserAndClaimHistory` attaches every past purchase from that wallet on first
  sign-in. Scoped to `user_id IS NULL`, so a credit already on an account is never moved.
- `scan_results` holds the **unfiltered** payload for 7 days. A receipt that returns only the wallets
  clearing the quality bar is not the thing the buyer paid for. Re-download reads storage and **never
  re-runs the scan**.
- Verify any change to the above with `npm run test:accounts` (needs a running dev server; spends
  upstream API credits). `npm run test:credits` covers the anonymous path.

## Architecture notes

- `src/app/api/top-traders/route.ts` is the paid path. Everything else is supporting.
- Solana ranking is all-time; BSC/Base is a 90-day window. `recordScan` treats them differently —
  all-time overwrites, windowed only ever raises a stored figure.
- Without upstream API keys the app serves deterministic mock data from `src/lib/mockData.ts`, always
  flagged with `isDemoData: true`. Don't remove that flag.
- `PAYMENTS_ENABLED` unset means every scan is free. That's intentional pre-launch behaviour.
- `src/lib/scanSession.ts` issues an HMAC bound to one chain+token so `/api/wallet-detail` can't be
  used to mine data for tokens nobody paid to scan.
- `src/lib/rateLimit.ts` is backed by Upstash Redis when `UPSTASH_REDIS_REST_URL` is set, and falls
  back to per-instance memory when it isn't. `rateLimit()` is **async** — every call site must await
  it. It's a cost guard, not an authorization boundary.
- **`wallet_tokens` is a curated alpha-wallet database, not a scan log.** `meetsQualityBar`
  (2x AND $1,000) is a **write gate**: a wallet only earns a row by clearing it. That is deliberate —
  the table exists to accumulate wallets worth tracking, so a wallet appearing in it repeatedly is
  the signal. **The gate has never touched what a buyer sees**: the scan response carries every
  trader the upstream provider returned, ranked by realized PNL, and neither `solanaTracker.ts` nor
  `birdeye.ts` filters on the bar. Keep that separation — filtering the payload would be selling
  people less than they paid for, and storing everything would turn the archive into noise.
- **`drizzle-kit generate` is not safe here.** `drizzle/meta` only tracks as far as `0001`, so it
  would try to recreate the whole schema. Hand-write the numbered `.sql` file and apply it with
  `npm run db:migrate -- 0018_user_accounts` (which now takes named files, in order — it used to
  apply only the newest and silently skip the rest).

## UI conventions

- **Every animation lives in `globals.css` and has a matching `prefers-reduced-motion` opt-out** at
  the bottom of that file. Adding one to the top without adding it to the bottom is the bug.
  Anything driven by a JS timer (auto-advance, staged reveals) must additionally read
  `useReducedMotion()` — CSS cannot stop a `setInterval`.
- **Nothing inside `TradersTable` is animated.** The virtualized lists render up to 500 rows and
  remount on scroll, so a per-row entrance animation would flash rows as you scroll and eat the
  render budget the hardening pass bought back. Keep animation in the small lists.
- `transform` and `opacity` only. Nothing that triggers layout.
- **`.tnum` on every number that changes while someone is watching it.** A count that reflows as it
  updates reads as broken.
- `useFocusTrap` for modals; `:focus-visible` is styled globally, so don't add per-component rings.
- Exactly one list is mounted at a time (`useMediaQuery`), never both hidden with CSS — that was
  ~1000 live row subtrees at Top 500 and is what froze phones.

## Style

- Comments explain *why*, not *what*. The existing code does this well — match it.
- No `any`. No non-null assertions on data crossing a trust boundary.
- Errors from upstream providers go through `src/lib/upstream.ts` so the user sees a sane message.
- Analytics, enrichment, and history are best-effort: they must never throw into a paid request path.

## Working style

- One task at a time. Commit each with a clear message before starting the next.
- If a change touches the schema, generate a Drizzle migration — don't hand-edit `drizzle/meta`.
- If something looks like a bug but isn't what you were asked to fix, mention it, don't fix it.
- Don't add dependencies without saying why.