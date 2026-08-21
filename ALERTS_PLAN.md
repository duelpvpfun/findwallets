# Real-time wallet stream and alerts — build plan

Status: **plan only, nothing built.** Agreed sequence with the owner 2026-08-21,
to be executed from 2026-08-22. Confirm with him before starting.

The product this is aiming at, in his words:

> good wallet 1 bought 2 mins ago, then another good wallet buys → we fire
> notification `2 good wallets bought [avg 5.75x] | [avg 50K pnl] into $FFGGGF in
> the past 2 minutes`. same for 3,4,5,6 wallets. then we will have direct links to
> top trading bots etc for referral

Three things in that sentence drive the whole design, and none of them are the
obvious ones:

1. **It escalates.** 2 wallets fires, then 3 fires, then 4. It is not one
   threshold with a cooldown — it is one alert per count, per token.
2. **The wallets' track record is in the message.** `avg 5.75x` and `avg 50K pnl`
   come from `wallet_tokens`, our own curated history, not from this trade. That
   line is the entire reason the alert is worth reading, and no competitor
   scraping a mempool can produce it.
3. **The alert is a monetisation surface.** Referral links to trading bots sit
   inside the notification, so every alert is a revenue opportunity rather than a
   cost centre.

---

## 0. Fix the bot flag FIRST (blocking)

`looksLikeBot` in `src/lib/db/record.ts` flags any wallet with **5,000+ lifetime
trades** as a bot. The owner's call, 2026-08-21: *"5000+ lifetime trades is normal
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
be built on. Filtering bots out of the top 500 would throw away our best signal.

**The fix:**

- Trust upstream tags only. Delete the `BOT_LIFETIME_TRADES_THRESHOLD` branch.
- Backfill to clear the 502. **`is_bot` is sticky** in the upsert
  (`is_bot = ${wallets.isBot} or excluded.is_bot`), so a wallet flagged once stays
  flagged forever no matter what a rescan says. Clearing rows that have no bot tag
  is required, not optional.
- Keep the sticky OR for tag-derived flags. That part is working.

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

1. **Referral codes** for Photon / BullX / Trojan / Axiom / GMGN — needed before
   the links can go in the message.
2. **Telegram bot token** from @BotFather.
3. **Upstash account** — free signup, paid tier when volume justifies it.
4. **The dead Helius webhook** — leave it or delete it?
5. **Do the bot-flag fix now or as part of tomorrow's first step?** It changes
   stored data (clears 502 rows), so it wants its own commit either way.
6. **Alert stats definition** — `avg 5.75x` as the mean of each wallet's mean
   multiple across all its stored tokens is my reading; confirm that is what he
   means rather than, say, its best trade.
