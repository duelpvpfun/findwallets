<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Alpha Wallet Finder (findwallets)

Paste a Solana / BNB Chain / Base token contract address, get its top 100–500 traders ranked by
realized PNL, export them as JSON for a tracking bot. **Users pay real money in SOL/USDC per scan.**

Deployed on Vercel. Live at **www.alphawallets.fun** (the `*.vercel.app` host still answers).

**Set `NEXT_PUBLIC_SITE_URL=https://www.alphawallets.fun` on every environment.** Vercel sets
`VERCEL_PROJECT_PRODUCTION_URL` to the `*.vercel.app` host automatically, and `SITE_URL` falls back
to it — so leaving `NEXT_PUBLIC_SITE_URL` unset silently brands every outbound link, OG tag and
Telegram alert with the deploy URL instead of the domain.

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
| `normalizeAddress` (`chains.ts`) | `scripts/import-export.mjs` | A second `tokens` row for one contract, splitting its history |
| `MIN_COST_BASIS_USD`, `MAX_PLAUSIBLE_MULTIPLE_X` (`quality.ts`) | `scripts/sync-alert-wallets.mjs` | Dust-basis "588x" wallets onto the alert roster, inflating every alert's headline |
| `MIN_SCOREBOARD_MCAP_USD` (`alerts/config.ts`) | `scripts/alerts-stats.mjs` | The CLI and the /alerts page disagree about which alerts count |

**EVM addresses are stored lowercased; Solana is stored exactly as given.** Every `(chain, address)`
unique index in the schema is case-sensitive, but an EVM address is not — Birdeye returns them
checksummed and a buyer pastes whatever they copied. The same contract in two casings therefore
minted two `tokens` rows, each accumulating its own `wallet_tokens` history; three BNB Chain tokens
had already split this way, including the `showcase` one. `normalizeAddress` in `src/lib/chains.ts`
is the choke point — call it on anything reaching a `(chain, address)` key. **Never apply it to
Solana:** base58 is case-sensitive and lowercasing a mint yields a different, wrong address. Reads
that take a user-supplied address compare with `lower()` on both sides (`tokenMeta.ts`,
`showcase.ts`, `identities.ts`), which is why display was never affected by the split — only storage.
`scripts/merge-duplicate-tokens.mjs` repairs existing splits and must run **after** the normalizing
code is deployed, or the next scan re-creates one.

**A `Date` interpolated into a raw `sql` fragment does not work.** `sql\`${col} > ${aDate}\`` skips
drizzle's type mapper, so `postgres.js` is handed a bare `Date` and the query dies at bind time with
`ERR_INVALID_ARG_TYPE`. Use the typed helpers (`gt`, `gte`, `lt`) against the column, or — inside a
hand-written statement where there is no column to take a mapper from — bind
`date.toISOString()` with an explicit `::timestamptz`. This made every sign-in return a 500.

**`sql.json(x)`, never `JSON.stringify(x)::jsonb`.** postgres.js JSON-encodes a bound value on
its way to a `jsonb` parameter, so a pre-stringified array arrives as a jsonb *string containing*
the array. `jsonb_to_recordset` then fails with `cannot call jsonb_to_recordset on a non-array`.
This bit the alert roster's bulk upsert.

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

## Smart money alerts

Live Solana stream. A Helius enhanced webhook feeds `/api/stream/solana`, which classifies buys,
counts distinct wallets in rolling windows, and announces each escalation step once to Telegram and
to the free `/alerts` page. Entirely separate from the paid scan path — a broken alert must never
be able to cost a buyer a credit.

**The tiers are the owner's, 2026-08-21.** 2 wallets in 2 minutes, 3 in 5 minutes, 4+ within the
hour, then 5, 6, 8, 10, 15, 20. Repeat buys from one wallet count once. Buys under $50 do not
count. A wallet that already sold still counts toward the tier and is marked `exited` — the entry
is the signal, and the reader deserves to know before chasing it.

**Never filter the Helius webhook on `transactionTypes: ["SWAP"]`.** Measured against 120 real
transactions from six roster wallets: Helius typed a DFLOW-routed swap as `UNKNOWN`, and typed
three genuine pump.fun sells as `TRANSFER` because an unrelated USDC transfer in the same bundle
won its description heuristic. `src/lib/alerts/classify.ts` therefore ignores `type` and
`events.swap` entirely and reads balance deltas: the wallet's balance of exactly one non-quote mint
went up while a quote asset (SOL/WSOL/USDC/USDT) went down. That shape is one no transfer or
airdrop can imitate, and it is the only reason the feed is not full of airdrop spam. The webhook is
registered with `["ANY"]`; roughly half of what arrives is noise the classifier discards.

- **Deltas come from `accountData`, not `tokenTransfers`.** A multi-hop route lists the same mint
  across four transfer legs and summing them double-counts. The account delta is already net.
- **The network fee is added back** (`nativeDeltaSol`), or a wallet that merely paid a fee and
  received a token reads as a buy.
- **Two memecoins bought against one pot of SOL are skipped, not split.** There is no honest way to
  divide the quote amount, and reporting a size nobody traded is worse than missing an alert.

**Idempotency and escalation are both unique indexes, never read-then-write.** Helius retries every
non-2xx, and one transaction reaches us once per tracked wallet in it.

| Index | Stops |
|---|---|
| `wallet_events_dedupe_idx` | A retry double-counting a wallet and firing a tier off one buy |
| `alerts_fired_key_idx` on `(chain, token, tier, episode)` | The same escalation step announcing twice |

`alert_state.episode` increments after `EPISODE_GAP_SECONDS` (2h) of silence on a token, in the
same upsert that reads it. Without an episode a token could only ever alert once in its life; with
a read-then-write, two concurrent deliveries both read the same episode and one alert vanishes into
a conflict. When a burst crosses several tiers at once only the highest is announced — the lower
ones are claimed in the same statement as `superseded` so they can never fire later on a smaller
count, and they are excluded from the feed and every performance figure.

**`/api/stream/solana` returns 200 for everything except a failed auth check.** Helius auto-disables
a webhook that keeps failing — "100.0% failure rate over 7d" is exactly how the previous webhook on
this account died, silently, while its dashboard still looked healthy. A malformed delivery is not
worth that risk. The hourly cron carries a heartbeat for the same reason: no events for 90 minutes
posts a warning to Telegram.

**The peak alone is not a result, and the scoreboard must be able to show a loss.** `ath_mcap_usd`
is a running maximum seeded at the entry cap, so `ath / entry` is >= 1.00 **by construction** — the
first version of this reported only that, and every tier looked profitable. `low_mcap_usd` (the
drawdown) and `mcap_{1,6,24}h_usd` exist to counterweight it: the drawdown says whether a call would
have stopped you out before it ran, and the 24-hour mark is the closest thing to a result anyone
could have taken. On the first 185 live calls the median peak was 1.00x while the median drawdown
was 0.45-0.80x and 30-50% rugged, which is the whole point. **Report medians, never means** — one
50x drags a mean anywhere. Anything that shows peak without drawdown beside it is lying.

**Every alert pins the market cap it fired at, and the cron keeps the running maximum.**
That ratio is the scoreboard, and it is the only honest answer to "which alert type is worth
reading". Supply is pinned at alert time and every later sample is `price x that supply`, so a
supply change cannot masquerade as a market-cap move. `greatest()` means the peak only ever moves
up. Alerts that fired under $20K market cap are excluded from the averages — a $3K cap doubling is
one buy, and a handful would flatter every figure into fiction.

**Volume knobs exist but ship OFF.** The tiers were calibrated for a ~500-wallet roster; at 1,685
the measured live rate was **561 alerts an hour**, because two proven wallets buying the same token
inside two minutes happens by coincidence constantly. `ALERTS_TELEGRAM_MIN_TIER`,
`ALERTS_MIN_MCAP_USD` and `ALERTS_MIN_BUY_USD` are all inert by default — **the owner asked to
choose the approach himself, so nothing is throttled without him saying so.** When one is set, a
suppressed alert is still recorded and still tracked, because a suppressed call that turns out to
have been good is the only evidence the knob is wrong.

**Market caps are sampled every 10 minutes for the first 24 hours, then hourly.** A memecoin's peak
is almost always inside the first day, and the running maximum is only as good as the sampling rate
around it — but ten-minute resolution for a full week is six times the upstream cost for detail
nobody reads. `fetchTrackingTokens` does the tapering in its `HAVING`. Note it uses seconds
arithmetic rather than `make_interval(secs => $n)`: Postgres cannot infer a type for a bound
parameter in that argument position and the statement fails to plan.

**One token escalating 2 -> 3 -> 4 is ONE call, and the feed groups it as one.** Each step still
writes its own `alerts_fired` row — that is what makes each fire exactly once, and what lets the
tier scoreboard answer "would you have done better entering on the 2-wallet alert or the 4-wallet
one". But `fetchAlertFeed` groups by `(token, episode)`: **entry market cap comes from the FIRST
step** (crediting ourselves with the 4-wallet entry after announcing at 2 would be marking our own
homework), the roster and averages come from the highest, and the peak is shared because it is a
property of the token. In Telegram each escalation replies to the first message of its own call.

**`/feed` is owner-only until `ALERTS_PUBLIC=1`.** The page renders exactly as it will in
public and is reached with the `/admin` cookie, so what gets reviewed is the real page rather than
a preview of it, and shipping is an env var rather than a diff. **The gate covers the page, the
JSON feed and the sitemap together** — a private page served by a public endpoint is a public page
with extra steps, and the three must flip in one move.

**The public feed masks wallet addresses, and that is a business boundary.** The curated list of
proven wallets IS the paid product — it is what a scan sells and what every paid upstream call in
the database went into assembling. `fetchAlertFeed` truncates to `abcd…wxyz` at the read that
serves `/api/alerts/feed`, **not** in the component: truncating in the UI would leave the full
addresses sitting in the JSON, where polling the endpoint rebuilds the whole database for free. The
stored `alerts_fired.wallets` keeps the real address for our own use. Anything that needs a
resolvable address must read the table directly, and nothing on the public path may link one to a
block explorer.

**Telegram cannot make arbitrary text copy something else** — a `<code>` span copies its own literal
contents, so tapping a ticker cannot yield the contract. The `copy_text` inline button does it
instead, with no bot round trip, and it works from a channel post. It is the first button and alone
on its row, because copying the contract is the step between reading an alert and owning the coin.

**The roster is quality-selected, not `times_seen`-selected.** `scripts/sync-alert-wallets.mjs`
takes wallets with one 4x+ win, or two 3x+ wins, or a 2x with $5K+ profit — and only counts rows
with a real cost basis (see the duplication table above). `times_seen` measures which tokens
customers happened to scan at least as much as it measures the wallet. Rows are deactivated, never
deleted: an alert fired last week still names them.

**The script writes the roster AND the Helius address list.** Splitting them is how they drift — an
address Helius streams that `alert_wallets` does not know is wasted invocations, and a wallet in
the table Helius is not watching is never alerted on. Run it only after the route is deployed.

```bash
npm run alerts:sync                       # report only
npm run alerts:sync -- --apply            # roster + Helius
npm run alerts:sync -- --apply --db-only  # roster only
npm run alerts:stats                      # tier performance, stream liveness, delivery failures
npm run alerts:replay -- --classify       # what the classifier makes of real recent transactions
npm run alerts:replay -- --wallets 6      # POST them to a running server
npm run alerts:replay -- --simulate       # force an alert end to end; --undo cleans up
```

**`ALERTS_RAW_MODE=1` forwards every classified trade to Telegram, unaggregated.** The verification
gate: buy classification is the one part of this system that cannot be proven correct by reading
it. Turn it on for a few hours, check the lines against Solscan, turn it off. Never leave it on.

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
- **The gate only runs on write, so revisions can leave stale rows behind.** A backfill that
  recomputes or nulls `multiple_x` (`purge-dust-basis.mjs`, `backfill-pnl-math.mjs`) can push an
  already-stored row below the bar, and nothing re-checks it. After any such backfill, run
  `node --env-file=.env.local scripts/purge-noncompliant.mjs` — it reports by default and needs
  `--apply` to delete. It also sweeps wallets left with no compliant trade, exempting any that still
  carry GMGN `win_badges` **or a non-null `identity_source`** (see below).
- **`wallets` also holds a curated identity directory, and it has no trades of its own.**
  `scripts/import-kol-wallets.mjs` loads `data/fomo-kols.json` (a FOMO leaderboard dump) into three
  rows per person — solana, bsc, base — carrying nothing but `identity_name`, `twitter` and
  `identity_source = 'fomo'`. It exists because Birdeye returns no identity at all and Solana Tracker
  only sometimes does, so every BNB Chain and Base row rendered as a bare address. `identity_source`
  is the flag that keeps `purge-noncompliant.mjs` from deleting the whole import as orphan rows: a
  curated entry never claimed to have a trade. **Both halves have to move together** — drop the
  exemption and the next `--apply` silently undoes the import. EVM addresses are stored lowercased
  and matched with `lower()` in `src/lib/db/identities.ts`, because Birdeye hands us checksummed
  addresses and an exact match finds nothing.
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