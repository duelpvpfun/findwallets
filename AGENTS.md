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
```

Typecheck and lint are slow on small machines. Run them at the end of a work session, not after
every edit, unless asked.

## Rules that will bite you

**Two different database URLs.** `DATABASE_URL` / `POSTGRES_URL` must be the Supabase **transaction
pooler** string (port 6543, `pooler.supabase.com`) — the app runs on serverless and would otherwise
exhaust connections. `POSTGRES_URL_NON_POOLING` is the direct connection and is only for migrations.
Never swap them. `src/lib/db/index.ts` sets `prepare: false` because the pooler doesn't support
prepared statements.

**Never fan out concurrent database queries.** `postgres.js` pipelines queries onto its pooled
connections, and when a fan-out outruns the pool, Supabase's transaction pooler stops answering
entirely — the queries never resolve and the request hangs until the platform kills it. Measured
against the live database: 4 concurrent queries on a pool of 1 never returned; 11 on a pool of 3
never returned; the same queries run one after another finish in milliseconds. `src/lib/db/index.ts`
sets `max: 3`, so **a `Promise.all` of database calls is a latent hang, not a speed-up**. Await them
in sequence. This is what made `/admin` unreachable.

**`scripts/*.mjs` cannot import from `src/lib`.** Everything under `src/lib` is behind the
`server-only` boundary. This is why `scripts/enrich-wallets.mjs` duplicates the constants from
`src/lib/quality.ts`. **If you change `MIN_WALLET_MULTIPLE_X` or `MIN_WALLET_PNL_USD`, change both
files or the worker and the app will disagree about what's worth storing.**

**Anything touching money needs care.** These files decide whether a paying user gets what they paid
for:

- `src/lib/access.ts` — resolves entitlement per request
- `src/lib/db/credits.ts` — reserve / release / create credits
- `src/app/api/pay/init/route.ts` and `pay/confirm/route.ts` — quoting and on-chain verification
- `src/lib/solanaPay.ts` — transaction building and signature verification

Do not change the semantics of these without flagging it first. In particular:

- `reserveCredit` uses a single atomic `UPDATE ... WHERE consumed_at IS NULL ... RETURNING`. This is
  what stops two concurrent scans sharing one purchase. **Never refactor it into a read-then-write.**
- The credit is consumed **before** the scan runs, so any path where the scan dies without calling
  the release path costs a buyer their purchase.
- Payment confirmation is verified server-side against chain data. Never trust a browser-reported
  success.

**Entitlement is enforced server-side only.** The client can ask for 500 wallets; `resolveAccess`
decides what it actually gets. Never move a gate into the browser.

**Credentials travel in headers, not query strings** (`x-claim-token`, `x-owner-key`) so they stay
out of access logs and Referer headers. Keep it that way.

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