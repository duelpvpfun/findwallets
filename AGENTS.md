<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Alpha Wallet Finder (findwallets)

Paste a Solana / BNB Chain / Base / Robinhood Chain token contract address, get its top 100–500 traders ranked by
realized PNL, export them as JSON for a tracking bot. **Users pay real money in SOL/USDC per scan.**

Deployed on Vercel. Live at **www.alphawallets.fun** (the `*.vercel.app` host still answers).

**Set `NEXT_PUBLIC_SITE_URL=https://www.alphawallets.fun` on every environment.** Vercel sets
`VERCEL_PROJECT_PRODUCTION_URL` to the `*.vercel.app` host automatically, and `SITE_URL` falls back
to it — so leaving `NEXT_PUBLIC_SITE_URL` unset silently brands every outbound link, OG tag and
Telegram alert with the deploy URL instead of the domain.

## Stack

- Next.js 16 (App Router), React 19, TypeScript, Tailwind v4
- Drizzle ORM + `postgres.js` against Supabase Postgres (us-east-1)
- Upstream data: Solana Tracker (Solana), Birdeye (every EVM chain), Helius (payment verification)
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
| `MIN_COST_BASIS_USD` (`quality.ts`) | `scripts/sync-alert-wallets.mjs` | Dust-basis "588x" wallets onto the alert roster, inflating every alert's headline |
| `MIN_SCOREBOARD_MCAP_USD` (`alerts/config.ts`) | `scripts/alerts-stats.mjs` | The CLI and the /alerts page disagree about which alerts count |

**Birdeye's published network list is stale; `GET /defi/networks` is the truth.**
`docs.birdeye.so/docs/supported-networks` omitted `robinhood`, `hyperevm` and `mantle` while the
API served all three — reading the docs page produced the confident, wrong conclusion that Robinhood
Chain needed a whole new provider and a hand-written PNL aggregation. Adding a chain starts with
that endpoint and a live call per endpoint the paid path uses, not with the documentation.

**Adding an EVM chain is six `Record<Chain, …>` entries and nothing else, by design.** Widen the
union in `types.ts` and `npx tsc --noEmit` enumerates the rest; every runtime branch in `src` is
`solana` vs not, so a new EVM chain takes the Birdeye path, the lowercase-address path and the
windowed `recordScan` path with no code written. Payments never needed touching at all: `chain` is
only a label on the credit reservation and settlement is in SOL/USDC whatever is being scanned.
What is NOT type-checked, and so has to be found by hand: the `chain in (...)` IN-lists in
`scripts/enrich-wallets.mjs`, `scripts/enrich-stats.mjs` and `scripts/backfill-evm-holdings.mjs`,
where a missing chain is never enriched and never says so.

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

**A multiple is never suppressed for being large.** `MAX_PLAUSIBLE_MULTIPLE_X` used to
null any multiple over 500x as an artifact, which is a statement about the size of a number rather
than about a trade. It hid a wallet that turned $299 into $204K while the entry and exit market caps
on the same row read $34.8K → $23.75M — 682x, the row calling its own figures implausible — plus
several that bought 10-19M tokens for $48-$212 and sold a fraction for six figures.

What that ceiling was groping for is **untracked inventory**. The artifact in its original comment
(one $39.46 buy, 225 sells of 15.95M tokens) is not suspect because 587x is big; it is suspect
because it sold far more tokens than it bought, so most of what it sold arrived by transfer and has
no recorded cost. `basisCoversSold` tests exactly that, and it decides **which denominator is
right, never whether to show one**: covered means the sold lots' own cost however few dollars it is,
uncovered falls back to everything spent, which understates rather than inflates. Measured on a
500-wallet scan: 16 rows read `n/a` before, 0 do now, and all 415 covered rows produce a multiple
that matches their independent price ratio exactly.

The dollar floor came off the display for the same reason — $48 spent on 19M tokens is a real
position when 15M of them are what got sold. It stays on the **roster** (`bought_usd >= 100` in
`sync-alert-wallets.mjs`), which is a separate question, and so does that script's 500x cap. Those
two now diverge from the app on purpose; see the note in the script.

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

**The alerting band is $10K-$1M, checked at the moment a tier fires.** The owner's rule: below
$10K one buy moves the chart, above $1M the reader cannot get the entry the wallets did. A tier that
crosses outside it is still **claimed** — so it can never fire later on the same count — but marked
`out_of_band`, which keeps it off Telegram, out of the feed and out of every figure. That is what
makes the rule behave as intended: two wallets in at $5K is skipped, and the third buying at $11K
fires **with $11K as the entry**, because $5K is a price nobody was told about.

**The scoreboard counts good calls, not losses.** Memecoins mostly go to zero, so the downside is
near-constant and carries almost no information; what varies is how often a tier catches a runner
and how far it runs. So: hits at 2x/5x/10x, normalised per day, and the median peak **of the
winners** (a median over all calls is ~1.00x and says nothing). The drawdown is still recorded — the
same sample writes it, so it is free — and still shown per call in the feed, so a "hit" can be
checked against how rough the ride was.

**The peak is a ceiling nobody sells into, so `/admin` also shows 1h / 6h / 24h.**
`mcap_1h_usd`, `mcap_6h_usd` and `mcap_24h_usd` were written by the tracking cron from the day the
scoreboard shipped and read by **nothing** for as long. They are the only figures that answer "what
would holding have paid", and unlike the winner-size column they are taken over **every** scored
call including the zeros — a hold figure that excluded the losers would be worthless. Each carries
its own sample count so a dash reads as "too early" rather than "no edge". `Peak in` (median
minutes to the peak, winners only) is the other half: "6.4x" and "6.4x in 40 seconds" are the same
number and different products, and only one of them a reader in a channel could have acted on.

**`fetchAlertCuts` slices calls by something other than the tier, and every cut but one is taken
from the FIRST announced step** — so it reads as what was knowable when the message went out.
Entry cap, roster dollars in, cluster span and sold-share are at-post; "escalated to" is labelled
hindsight because it is the strongest correlate in the data and cannot be turned into a filter.
All five dimensions come out of **one** statement via a lateral `VALUES` join, because a query per
dimension is a fan-out against a pool of three. `rugRate` is in that table and has no equivalent in
the tier table on purpose: a cut can be worth making because it removes losers rather than because
it finds winners, and a hit rate cannot show that.

**`fetchAlertSuppression` is what makes the volume knobs falsifiable.** The rule elsewhere in this
file is that a suppressed alert stays in the record "because a suppressed call that turns out to
have been good is the only evidence the knob is wrong" — and until 2026-08-22 nothing displayed that
evidence, so the rule was true and useless. Counted in **steps**, not calls, because the unit a
filter removes is a message. `n/a` in that table is honest and expected: an out-of-band step and a
superseded step are never tracked, so there is no peak to score them against. The knobs it *can*
hold to account are the ones that suppress but keep tracking — min tier, min cap, mostly-sold.

**`/admin` shows every scored call as a card, best first, under the tables.** `fetchCallCards` is
deliberately not `fetchTopCalls`: the pin's query serves Telegram, so it is limited to calls that
reached the channel and traded above their entry. The operator's has the opposite obligation —
suppressed calls are IN it and labelled `not sent`, because a call held back that went on to run is
the only evidence a knob is pointed the wrong way. It also carries the **full contract address**:
the masking in `fetchAlertFeed` is a business boundary on the public read, and applying it here
would only stop the owner checking his own call against a chart.

**The scoreboard must never be served by `/api/feed`.** It was, for a while, unread by any caller,
on the endpoint that goes public with `ALERTS_PUBLIC` — the same mistake as a private page served by
a public route. Hit rates and hold medians are how the product gets tuned; publishing them invites
an operator's median being read as a return somebody made. `/admin` only.

**Two arithmetic traps in that table, both of which shipped wrong once.** The headline must count
**calls**, not `alerts_fired` rows: a token escalating 2 → 6 writes five rows, and summing the tier
table reported one token as five ten-baggers. And the per-day denominator is **floored at one day**,
because 113 calls over forty minutes extrapolates to "4,082 calls/day".

**`ath_mcap_usd` is never seeded from the entry cap.** Doing that made a call seconds old read
"called at $3.2K, peak $3.2K" — a peak nobody had observed, only assumed — and made `peak / entry`
>= 1.00 by construction, so no call could ever read as a loss. It starts null and the first real
sample sets it.

**A token whose last market cap is under `DEAD_MCAP_USD` ($4K) is abandoned by the tracker.** Most
never come back, and re-reading them every ten minutes for a week is the bulk of the tracking spend
for no information. The check is on the last cap seen, so a token that never gets that low keeps
being tracked normally.

**Every alert pins the market cap it fired at, and the cron keeps the running maximum.**
That ratio is the scoreboard, and it is the only honest answer to "which alert type is worth
reading". Supply is pinned at alert time and every later sample is `price x that supply`, so a
supply change cannot masquerade as a market-cap move. `greatest()` means the peak only ever moves
up. Alerts that fired under $20K market cap are excluded from the averages — a $3K cap doubling is
one buy, and a handful would flatter every figure into fiction.

**A step whose wallets have mostly sold does not reach Telegram.** `MAX_SOLD_SHARE` (0.6, the
owner's rule 2026-08-22) suppresses the *message* when more than 60% of the window is already out.
It is a Telegram suppression only: the step keeps its claim, stays on the feed and keeps being
tracked, because **the first night of data says the rule is pointed the wrong way.** Measured over
263 announced steps it removes 33 of them (13% of messages) and silences exactly one call — and the
steps it removes hit 2x more often (8 of 32) than the steps where nobody had sold (16 of 110).
Sold-share climbs with elapsed time and with the wallet count, so it partly measures "this call ran
and people took profit"; BOTFIRM, the 21-wallets-17-sold call that prompted the rule, went on to
peak at **3.85x**. Keeping the suppressed steps in the record is the only thing that can settle it.
Set `ALERTS_MAX_SOLD_SHARE=1` to switch it off.

**Peak leads the feed row, not "now".** Almost every memecoin is below its top an hour later, so
leading with the current multiple made a feed of `▼ 0.10x` — bearish about calls that had run 4x. The
peak is the number that says what the call was worth. Nothing is hidden to get there: "now" is still
on the row (muted), the low is in the open row, and **the peak still gets no up-arrow below 1.2x**
because `ath_mcap_usd` starts null and is only ever set by an observed sample, so it genuinely can
come in under 1.00x.

**"Average big wins", never "their record".** `avg_multiple_x` and `avg_pnl_usd` are means over the
wins stored in `wallet_tokens` — and only wins are ever stored there, because `meetsQualityBar` is a
write gate. Calling that a wallet's "record" claims a lifetime figure we do not have and cannot
support, and it reads as inflated to anyone who checks. Three places say it and must agree:
`buildAlertMessage`, the `FeedTerminal` column header, and the `FeedRow` detail grid.

**Every buy link goes out through `/api/go`, which counts the tap.** Owner's ask, 2026-08-22:
"might need to know how many people click on axiom pumpfun gmgn links from tg and website to know
the traffic driven". A venue's own referral dashboard cannot answer it — it shows the conversions
that landed on that one venue and nothing about the taps that went elsewhere, so a button nobody
uses looks identical to a button nobody converts on.

- **The destination is rebuilt server-side from the venue slug, never passed in.** The request
  carries `v` (slug), `c` (chain), `t` (address) and `s` (source); the URL is composed from
  `TRADE_LINKS`. A redirector that forwards to a caller-supplied URL is a phishing tool wearing our
  domain, so this is not negotiable. The address is shape-checked per chain — base58 for Solana,
  `0x` + 40 hex for EVM — and never looked up, because an alert can fire on a mint no scan has
  touched and refusing those would break the newest calls first.
- **It also wins the site its referral codes back.** Referral codes are private env vars, so a
  client component could only ever render `link.plain(...)` — every tap from the feed was earning
  nothing. Resolving the destination on the server fixed that as a side effect.
- **The redirect never waits on the write.** `after()` runs the insert once the 302 is out, so a
  slow database costs a data point rather than a buyer. Anything unrecognisable redirects to `/`
  rather than erroring: a reader who taps a button has earned a destination.
- **302 with `no-store` at all three cache layers.** A cached redirect is a click that never reaches
  the function, which is the one failure that would silently zero the numbers.
- `source` is `tg` / `feed` / `scan`, and Telegram is a separate column from the site at every level
  in `/admin`'s "Where the clicks go" — a combined total cannot tell a working channel from a
  working website, which is the only thing the table was added to answer. Clicks sit next to
  distinct visitors, because forty taps from one person is not reach.
- Rate-limited per IP at 40/minute, and a limited request **still redirects** — only the recording
  is dropped. `link_clicks` starts empty on deploy: there is no history before the first tap.

**Venue logos are self-hosted in `public/venues/`, keyed by `TradeLink.slug`.** Hotlinking a
third-party favicon leaks a referrer on every row of the feed and blanks the moment they move the
file, which is why these were monograms first. The fix is to own the bytes. **pump.fun replaced
BasedBot** (owner's call, 2026-08-22) and is the one venue with `refEnv: null` — no referral
programme, kept because nearly every call here is a pump.fun launch, and a link we earn nothing on
beats a link nobody taps. It is Solana-only: there is no pump.fun page for a BNB Chain or Base
contract, and a dead button is worse than one fewer. `ALERTS_REF_BASEDBOT` is now inert and can come
out of Vercel.

**Volume knobs exist but ship OFF.** The tiers were calibrated for a ~500-wallet roster; at 1,685
the measured live rate was **561 alerts an hour**, because two proven wallets buying the same token
inside two minutes happens by coincidence constantly. `ALERTS_TELEGRAM_MIN_TIER`,
`ALERTS_MIN_MCAP_USD` and `ALERTS_MIN_BUY_USD` are all inert by default — **the owner asked to
choose the approach himself, so nothing is throttled without him saying so.** When one is set, a
suppressed alert is still recorded and still tracked, because a suppressed call that turns out to
have been good is the only evidence the knob is wrong.

**Tracking runs on FREE data. DexScreener for spot, GeckoTerminal for the peak.**
Solana Tracker stays wired as the fallback for mints the free sources do not know (~a third, mostly
dying tokens), so it is now the exception rather than every sample. Neither free provider publishes
an SLA, which is why the paid path is not deleted.

**The peak comes from candle highs, not from a running maximum of spot checks — and that is a
correctness fix, not a saving.** $Link was recorded at $1.19M because that was the highest of seven
glances; it actually traded at **$2.22M**, and its entire run above $1.3M lasted thirteen minutes.
No polling rate catches that. A candle high does, and it does so **retroactively** — a spike at
04:29 is in the 04:29 candle forever — so `PEAK_CHECKS_PER_SWEEP` is a *rotation*, not a schedule:
cadence buys display freshness, never correctness. That is the opposite of the spot sampler, where
a missed tick is a lost observation.

Four things that bit, all of them shipped wrong once:

- **`token=<mint>` on the OHLCV request is not optional.** It defaults to the pool's BASE token, and
  our mint is regularly the quote side: $ELOTÉ's deepest pool is "ZEC / ELOTÉ", so the default
  returned ZEC at $834 a unit and multiplying by ELOTÉ's billion-token supply put a **$860 BILLION
  peak, 8,334,654x, on the public podium**.
- **`MAX_CANDLE_JUMP_X` (20) is a safety gate, not a knob.** Candle data reaches the podium and the
  pinned Telegram message with no human in between, so a bad read is fabricated rather than
  imprecise. It is checked against the best cap a *spot* sample actually observed — a different
  provider on a different code path, which is what makes it a real check. The largest genuine
  correction measured is 1.9x, so 20x rejects nonsense by orders of magnitude and never touches a
  real fix.
- **A failed peak check backdates its stamp instead of setting `now()`.** $Link was reconciled five
  minutes before its pool was cached, failed, and went to the back of a full rotation with the wrong
  number still on the podium. Backdating means a transient failure retries in minutes while a
  permanently unresolvable token still cannot block the queue.
- **The peak pass has its own queue and must not be nested inside the spot pass.** It was, and a
  tick with nothing due for sampling did no peak work at all.

**`SAMPLE_DUE_SLACK_SECONDS` fixes a real aliasing bug.** The cron fires every 10 minutes and the
due-check was "more than 600 seconds since the last one", so a token checked at 04:10:04 was 9m56s
old at the 04:20 tick, skipped, and waited for 04:30. Not random either: the sweep walks tokens
sequentially, so every token is checked past the tick and then misses the next one. Measured on
$Link the gaps were 18, 22, 19 and 19 minutes against a configured ten.

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

**Nothing in a Telegram message may link at `/feed` while `ALERTS_PUBLIC` is off.** The page and
its JSON endpoint both `notFound()` for anyone without the `/admin` cookie, so every alert in the
channel was sending every subscriber to "Page not found" — and it was invisible to the owner,
because his own browser carries the cookie and the link worked for him. `brandUrl()` now resolves
to `/` until the feed is public and `brandLabel()` renames the button to match. Setting
`ALERTS_PUBLIC=1` is still the real fix; this is what stops the gate from producing a dead link in
the meantime.

**A podium of the 24h top three sits above the feed, and it costs no extra query.** The server
renders the real top three (`fetchCallCards(chain, 1, 3)`); after that the client re-derives it from
the rows `FeedTerminal` already polls every eight seconds, so a call overtaking rank 3 is promoted
on the next tick and a growing peak is re-ranked. A second endpoint would have put a third
sequential query on a hot path for data the page already has. The 24h window is re-checked on the
client, or a tab left open overnight would keep yesterday's winner up forever.

**`/api/feed` is cached in two layers, and neither is optional at scale.** Every viewer polls it
every eight seconds and every one of them gets byte-identical data, so uncached, 1,000 concurrent
readers are 125 requests a second each running a 120ms grouped query against a pool of three - and a
fan-out wider than that pool does not queue, the transaction pooler stops answering entirely.

- **`CDN-Cache-Control` and `Vercel-CDN-Cache-Control`, not `Cache-Control`.** Next stamps
  `Cache-Control: no-store` on every dynamic route handler and silently overwrites whatever you set;
  those two survive, and on Vercel they are what actually controls the edge. Confirmed by reading
  the headers off a production build - `next dev` reports `no-store` either way, so testing it in
  dev proves nothing. The route therefore carries **no** `dynamic`/`revalidate` segment config: both
  re-impose `no-store`. It is dynamic regardless because it reads `request.nextUrl`.
- **The five-second in-process memo is the second layer**, because the first is somebody else's
  infrastructure and is most likely to be cold on some node exactly when a crowd arrives. It is
  keyed by `(no before, resolved limit)` - keying on `before` alone would serve a `?limit=5` caller
  the 60-row payload the pollers put there, which is a wrong answer rather than a slow one.
- **Cacheable only when `alertsArePublic()`.** While gated, the response depends on the /admin
  cookie and a shared cache cannot see that difference: one admin request would be stored and served
  to everyone. The private path is explicitly `no-store`, and a failed read is never cached - a
  cached empty feed outlives the outage that caused it.
- The client skips the poll entirely when `document.hidden`. Browsers throttle timers in background
  tabs but do not stop them, and abandoned tabs are load with no reader.

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

**A rug that was ever SCANNED poisons `wallet_tokens`, not just the roster.** A paid scan mints one
curated "win" per top trader, so a token with manufactured volume hands out 100x credentials
wholesale and those wallets then qualify for the alert roster on trades nobody really made.
$BULLBALLS was one scan and it minted **226 fake winners, 103 of them active on the roster** — and
every one of the 103 had qualified on that token *alone*, with zero appearances in any other call.
So `alerts:kill` sweeps three populations, not one: the frozen alert snapshots, every wallet the
stream saw trade the mint on **either side** (a seller with no recorded buy still held it), and every
`wallet_tokens` win on that mint. It prints how many of the affected roster wallets also qualify
somewhere else *before* writing, because that number is what blocking actually costs — zero here,
and it would not always be.

**A wallet ruled out by hand is blocked on `wallets.blocked`, never only deactivated.** The roster
is REBUILT from `wallet_tokens` on every `alerts:sync --apply`, so a wallet removed from
`alert_wallets` alone walks straight back in on the next sync and nobody notices. The block lives
next to the evidence that qualified it, and it is deliberately separate from `is_bot` — that one
records what an upstream provider said, this one records that a human looked and said no.
`npm run alerts:kill -- --symbol GHOUL --apply` deletes a bad call and blocks its buyers in one
move, because doing those separately is how one gets forgotten: the call without the block leaves
the wallets free to manufacture the next one, the block without the call leaves a fake multiple on
the public podium. It deletes `alerts_fired` and `alert_state` but **keeps `wallet_events`** — the
raw stream is the only evidence of how the call was manufactured and the only thing a rule change
can be replayed against.

**The roster is quality-selected, not `times_seen`-selected.** `scripts/sync-alert-wallets.mjs`
takes wallets with **one 5x+ win and nothing else** — and only counts rows with a real cost basis
(see the duplication table above). `times_seen` measures which tokens customers happened to scan at
least as much as it measures the wallet. Rows are deactivated, never deleted: an alert fired last
week still names them.

**That rule replaced a looser one on 2026-08-22 and took the roster 1,685 → 846.** The old rule was
"one 4x+, or two 3x+, or a 2x with $5K+ profit"; the two extra paths were letting wallets in on a
record nobody would have copied. Replaying the live buy stream against both: tokens reaching tier 2
fell 149 → 98, tier 10 fell 30 → 11, and every one of the thirteen calls that ran 1.5x+ still had
five or more surviving wallets, so none stopped firing. **Do not reach for the roster as a volume
control again** — halving it cut calls by a third, while gating the first Telegram post on tier 6 cut
messages 76% on the same data. Breadth is what makes confluence detectable; the roster is what makes
it credible.

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

**A pinned leaderboard sits at the top of the channel, refreshed hourly.**
`/api/cron/alert-pin` posts ONE message, pins it silently, stores its id in `bot_messages`, and
from then on **edits that same message** every hour. Twenty-four leaderboard posts a day would bury
the alerts the pin exists to advertise, and only one message can usefully be pinned anyway. It runs
at `:05` so it reads the peaks the `*/10` tracker wrote at `:00`.

**The pin's window is the LAST HOUR, not 24 hours** (owner's call, 2026-08-22). It shipped on 24
hours, which made it the same three calls as the 2pm recap for most of the day — and because the pin
is edited silently in place, the reader saw a board that never appeared to change followed by a
daily post telling them what they had already read. One hour restores the split: the pin is what is
happening now and earns its hourly refresh, the recap is the day and is the only 24-hour ranking in
the channel. **A quiet hour says so** — `buildLeaderboardMessage` never widens its own window to
fill the board, because reaching back for an older call presents it as if it just happened. The
empty state still carries the call count and the `updated HH:MM UTC` stamp, or a quiet hour would be
indistinguishable from a pin that stopped updating.

- **Per-call results only.** Ticker, the cap it was called at, the peak cap, the multiple and the
  percentage. These are the same numbers already on every public feed row. **The aggregate
  scoreboard stays on `/admin`** — a hit rate or a hold median on a pinned message is an operator's
  statistic being read as a return somebody made.
- **Only calls that actually reached the channel are eligible**, and they are the denominator too:
  `having count(delivered_at) > 0`. Headlining a step that mostly-sold suppressed would be crediting
  ourselves with a tip nobody was given.
- **The denominator ships with the list.** "3 best of 88 calls" is the same three rows as "Top 3"
  and an honest version of it.
- Grouped by `(token, episode)`, entry from the FIRST step, exactly as `fetchAlertFeed` does — the
  ungrouped rows would put one escalating token on the pin three times.
- **Only a message Telegram no longer has justifies posting a second one.** A rate limit or a
  network blip leaves the existing pin alone and retries next hour; re-posting on a transient error
  is how a channel accumulates six abandoned leaderboards. `isMessageGone` draws that line, and
  "message is not modified" counts as success — the pin is already correct.
- The id is recorded **before** the pin call and regardless of whether it succeeds. A bot without the
  right to pin still posted a real message, and forgetting it would post another every hour.
- Both operations are `disable_notification`. A pin normally notifies the whole channel, and doing
  that hourly is a reason to mute the channel, which would cost every real alert its notification.
- `?dry=1` renders exactly what would be pinned and posts nothing. `ALERTS_PIN_WINDOW_HOURS` (1)
  and `ALERTS_PIN_TOP_N` (3) are the knobs.
- **In a channel, pinning is covered by "Edit Messages", not "Pin Messages"** — the API omits
  `can_pin_messages` for channels rather than returning false, so reading its absence as denied
  reports a working bot as broken. `npm run alerts:telegram` checks the right one per chat type.

**A daily recap posts at 2pm New York, and it is the only message here that notifies.**
`/api/cron/alert-digest`, the owner's call 2026-08-22. Same builder as the pin — two copies of that
message would drift, and the pin and the recap disagreeing about what a call did is the one thing
that would discredit both. **Different window, same code:** the recap is fixed at 24 hours
(`DIGEST_WINDOW_HOURS`, deliberately not borrowed from `PIN_WINDOW_HOURS`) and the pin is the last
hour, so the two never say the same thing twice. The header names its own window and the footer
differs: the pin carries `updated HH:MM UTC` because it is edited in place and has to prove it is
still live, the recap carries its date instead.

- **The route runs hourly and posts at most once a day.** That is not a workaround — Vercel cron
  expressions are UTC, and America/New_York is UTC-4 for two thirds of the year. A fixed
  `0 19 * * *` would be 2pm in January and 3pm in July. Comparing the local hour is exact and needs
  no DST edit twice a year. `ALERTS_DIGEST_HOUR_LOCAL` (14) and `ALERTS_DIGEST_TZ` are the knobs.
- **Once a day is an index, never a read-then-write.** The row key is the local calendar day
  (`digest-2026-08-22`) and the claim is an `on conflict do nothing ... returning`, so a retried
  cron delivery collides instead of posting a second recap. Same rule as `alerts_fired_key_idx`.
  `?force=1` skips the *hour* check and cannot skip the claim; the escape hatch is deleting the row.
- **A failed send gives the day back.** `releaseBotMessage` only ever deletes a row whose
  `message_id` is still null, so a Telegram outage at 2pm gets retried at 3pm rather than costing
  the day, and a successful post can never be un-claimed.
- **A missed 2pm catches up later the same day** rather than being skipped: the gate is
  `local hour >= 14`, so a recap at 4pm because the 2pm run failed still happens. On first deploy
  after 2pm this posts once immediately, which is the same rule working, not a bug.
- It notifies. Everything else the bot sends is either an alert or a silent pin operation; a recap
  nobody is pinged for is a recap nobody reads.
- `?dry=1` renders it and posts nothing. `?dry=1&force=1` renders it outside the 2pm window.

**`bot_messages` holds messages the bot addresses by key rather than posting and forgetting.**
`leaderboard` is one row edited forever; `digest-YYYY-MM-DD` is one row a day. `message_id` is
nullable for exactly one reason: the recap's row is claimed *before* the message exists, which is
what makes the once-a-day guarantee a primary key instead of a check. `chat_id` is stored beside it
because a message id is meaningless outside its chat — repointing `TELEGRAM_ALERT_CHAT_ID` has to
post a new message, not edit an id that now belongs to a different channel.

**`ALERTS_RAW_MODE=1` forwards every classified trade to Telegram, unaggregated.** The verification
gate: buy classification is the one part of this system that cannot be proven correct by reading
it. Turn it on for a few hours, check the lines against Solscan, turn it off. Never leave it on.

## Architecture notes

- `src/app/api/top-traders/route.ts` is the paid path. Everything else is supporting.
- Solana ranking is all-time; every EVM chain is a 90-day window. `recordScan` treats them differently —
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