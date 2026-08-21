# Real-time wallet stream and alerts — build plan

Status: **built and verified locally, 2026-08-21. Not yet deployed.**

Sections 0-3 below are done. What is left is operational, not code:

| Step | State |
|---|---|
| Fix the bot flag | done 2026-08-21 |
| Schema, classifier, stream route, escalation, Telegram, /alerts page | **done, verified end to end** |
| Roster built and written (1,685 Solana wallets) | **done** |
| Deploy the branch | pending |
| Create the Helius webhook (`npm run alerts:sync -- --apply`) | **pending — needs a live URL** |
| Telegram bot token + channel | **pending — needs the owner** |
| Raw-mode verification pass | pending, after deploy |
| BNB Chain / Base | not started; Helius is Solana-only |

**Why the webhook was not created yet.** It has to point at a URL that answers. Helius
auto-disables a receiver that keeps failing, and that is exactly how the previous
webhook on this account died. `npm run alerts:sync -- --apply` creates it in one
command the moment the route is live; the API path is already proven against the
account (the existing webhook was read successfully, and is untouched).

**What was verified locally, against the live database and real chain data:**

- Classifier run over 120 real transactions from six roster wallets. Every
  `SWAP` source landed — PUMP_AMM, JUPITER, PUMP_FUN, RAYDIUM, RAYDIUM_LAUNCHLAB,
  OKX_DEX_ROUTER, BYREAL — plus one swap Helius typed `UNKNOWN` and three it
  typed `TRANSFER`. Zero events from `INITIALIZE_ACCOUNT`, plain transfers or
  airdrops.
- 90 real transactions POSTed to the route: 32 events stored. Re-POSTing the same
  payload inserted 0 — the dedupe index holds.
- Escalation forced with three real roster wallets on a real token: buy 1 fired
  nothing, buy 2 fired tier 2 (span 20s), buy 3 fired tier 3 (span 40s). Market
  cap pinned, symbol resolved, lower tier claimed as superseded.
- Hourly cron: sampled, appended to the series, and held the peak when the next
  sample came in lower.
- Auth: 401 with no header and with a wrong secret, on both the stream route and
  the cron.
- `/alerts` renders on desktop and mobile with no console errors, no hydration
  error and no horizontal overflow.

The design decisions and their reasoning now live in AGENTS.md under **Smart money
alerts**, which is the file that gets read. What follows is the original plan,
kept for the reasoning behind the shape.

---

## 0. Fix the bot flag FIRST — **DONE 2026-08-21**

`looksLikeBot` in `src/lib/db/record.ts` used to flag any wallet with **5,000+
lifetime trades** as a bot. The owner's call, 2026-08-21: *"5000+ lifetime trades is normal
dont flag as bots lmao otherwise we will flag most wallets."* He is right, and the
numbers are worse than the comment in that file claims:

| | |
|---|---|
| Wallets | 3,185 |
| Flagged `is_bot` | 710 |
| …by an upstream **tag** (`bot`, `sniper-bot`, `arbitrage`) | 208 |
| …**by the trade count alone** | **502** |
| Trade-count distribution | p50 813 · p75 3,576 · p90 13,474 · p99 113,363 |

The 5,000 line sits between p75 and p90, so it flags roughly a fifth of the
database for being *active*. And the damning part: the **three most-seen wallets
in the entire database** (22, 21 and 21 tokens each) are all flagged `is_bot`
purely on trade count. Those are precisely the wallets this alert product should
be built on. Filtering bots out of the top 500 would have thrown away our best
signal.

**Done, both halves:**

- `looksLikeBot` now trusts upstream tags and nothing else; the threshold branch
  is gone, and so is `scripts/backfill-bot-flag.mjs`, which is what applied the
  bad rule in bulk in the first place.
- `scripts/unflag-false-bots.mjs` (report by default, `--apply` to change) cleared
  **502 wallets** against the live database. 208 remain flagged, every one of them
  by an upstream tag. Re-running reports 0 to clear, so it is idempotent.
- The sticky OR stays for tag-derived flags. That part was working.

**Ordering caveat:** `is_bot` is sticky in the upsert
(`is_bot = ${wallets.isBot} or excluded.is_bot`), so until the code fix is
**deployed**, any scan touching one of those 502 wallets re-flags it. Re-run the
script after the deploy; it costs nothing and is safe to repeat.

Side effect worth knowing: `is_bot` gates the public wallet ticker
(`showcase.ts`), so those 502 — including the three most-seen wallets we have —
had been silently excluded from the homepage. They are eligible again now.

---

## 1. Tomorrow's sequence (his order, unchanged)

1. **Top 500 wallets onto a Helius webhook.** Selection: highest `times_seen`,
   tie-broken by `lifetime_pnl_usd`. 1,285 wallets appear on 2+ tokens and 651 on
   3+, so 500 sits comfortably inside the repeat-winner set. Bot filter: upstream
   tags only, per section 0.
2. **Land the transactions in Telegram properly and confirm it works.** Raw at
   first: wallet, token, size, signature, timestamp. No thresholds, no
   aggregation. This step exists to prove classification is right, and it is the
   decision gate for everything after it.
3. **Add the remaining wallets** once step 2 is trustworthy (~3,185 total today).
4. **Repeat for BNB Chain.** Helius is Solana-only, so this needs a second
   provider — Moralis Streams or QuickNode Streams, both of which cover BSC and
   Base with address lists.

Only after 1–4 does the escalating alert logic go in. Landing raw transactions
correctly is the hard part; counting them is easy.

---

## 2. What we already know about the infrastructure

**Helius account state, checked 2026-08-21.** There is already one enhanced
webhook on the account, pointing at
`liquititty-worker-production.up.railway.app`, with 0 addresses, and Helius
**auto-disabled it on 2026-07-13: "100.0% failure rate over 7d"**. Two
conclusions:

- The plan tier supports enhanced webhooks. Nothing to buy to start.
- **Helius silently kills a webhook whose receiver keeps failing.** A heartbeat is
  not optional: if events stop arriving for N minutes, we need to know, or the
  product is dead and the dashboard still looks fine. This has already happened
  once on this account.

Do not delete that webhook without asking — it belongs to another project.

**Upstash Redis is still unset**, and this is what finally forces it. The rolling
window cannot live in Postgres: `src/lib/db/index.ts` runs a pool of 3 against a
transaction pooler, and AGENTS.md forbids fanning out queries for exactly the
reason this workload would trip. The free tier (10k commands/day) is too small;
budget the paid tier.

---

## 3. Architecture

```
Helius enhanced webhook ──► /api/stream/solana ──► classify BUY
                                                     │
                                    ┌────────────────┴────────────────┐
                                    ▼                                 ▼
                          Redis rolling window              Postgres event log
                          ZSET per token                    (dedupe + history)
                                    │
                          count crossed a NEW tier?
                                    │
                    ┌───────────────┴───────────────┐
                    ▼                               ▼
              Telegram sendMessage            on-site feed row
```

No new servers: a Vercel route, Redis, and the Telegram Bot API.

**The window.** Per token: `ZADD buys:{chain}:{mint} {ts} {wallet}` — the wallet
is the member, so a wallet buying three times counts once. `ZREMRANGEBYSCORE`
trims the window, `ZCARD` gives the distinct count.

**Escalation without spam.** Fire when the count reaches a tier we have not
already announced for this token in this window: `SETNX fired:{mint}:{n}` with a
TTL. That gives 2 → 3 → 4 → 5 → 6 each exactly once, and nothing at all for the
7th buy unless it crosses the next tier. Cap the tiers (10, then only on
doubling) so a genuinely viral token cannot flood a chat.

**The stats line.** For the N wallets in the window, read their history from
`wallet_tokens`: per wallet, the mean `multiple_x` and mean `realized_pnl_usd`
across its stored tokens, then average across the N. One query per alert, not per
event, and it is the only Postgres read on the hot path.

**Message shape:**

```
🟢 3 good wallets bought $FFGGGF in the past 2 min
   avg 5.75x  ·  avg $50K PNL
   2fg5QD…  ·  GijFWw…  ·  ACTbvb…
   [ Photon ] [ BullX ] [ Trojan ] [ Axiom ]     ← referral links
```

The elapsed time is the **real span between the first and latest buy**, not the
configured window: "in the past 2 minutes" has to be true.

---

## 4. New tables

| Table | Purpose |
|---|---|
| `wallet_events` | Classified buys. Unique on `(chain, tx_signature, wallet, token_address)` for idempotency, since Helius retries. ~48h retention, not forever. |
| `alert_rules` | Per user: min wallets, window minutes, chain, min buy USD, delivery targets. |
| `alerts_fired` | What was announced, to whom, when. Drives the on-site feed and survives a Redis flush. |
| `users.telegram_chat_id` | Set by the link flow below. |
| `telegram_link_codes` | One-shot code behind a `t.me/<bot>?start=<code>` deep link. |

---

## 5. What will bite us

| Risk | Why it matters |
|---|---|
| **Buy classification** | Jupiter multi-hop, pump.fun curves, Raydium, plus transfers and airdrops that must not count. False alerts churn subscribers faster than no alerts. This is why step 2 is a gate. |
| **Postgres pool of 3** | No `Promise.all`. Batched multi-row inserts with `ON CONFLICT DO NOTHING`, one statement per webhook POST. |
| **Vercel invocations** | ~500 active wallets × ~30 tx/day ≈ 15k/day. Fine. All 3,185 wallets could be 5–10× that, which is the real reason step 1 is 500 wallets and not everything. |
| **Supabase rows** | 60k–500k events/day unpruned. Retention is part of v1, not a later optimisation. |
| **Silent webhook death** | Already happened on this account. Heartbeat required. |
| **Telegram limits** | 30 msg/s global, 20/min per group. A hot token alerting many users needs a queue, not a loop. |
| **Never touch the paid path** | Separate routes, separate failure domain, best-effort everywhere. A broken alert must not cost anyone a scan. |

---

## 6. Billing, when it gets that far

Sell it as a **30-day alert pass** through the existing Solana Pay flow and the
credit machinery that already exists. No Stripe, no subscription infrastructure,
no changes to the payment code. Referral links inside the alerts monetise the free
tier at the same time.

Suggested split: on-site feed free (it is the top-of-funnel and costs nothing per
user), Telegram alerts paid.

---

## 7. Open decisions

He is bringing these when he pings, 2026-08-22:

1. **Referral codes** for Photon / BullX / Trojan / Axiom / GMGN — needed before
   the links can go in the message.
2. **Telegram bot token** from @BotFather.
3. **Upstash credentials** — free signup, paid tier when volume justifies it.
4. **The dead Helius webhook** — leave it or delete it?

Settled:

- ~~Bot-flag fix~~ — done, section 0.
- ~~Alert stats definition~~ — **confirmed 2026-08-21**: `avg 5.75x` is the mean of
  each buying wallet's average `multiple_x` across all its stored tokens, then
  averaged across the wallets in the window. Not its best trade. Same shape for
  `avg 50K pnl`.
