# Migration notes

Everything the hardening pass added that lives outside the code: environment
variables, database migrations, and scheduled jobs. Read this before deploying.

## 1. Environment variables

Add these in **Vercel → Project → Settings → Environment Variables** (Production
*and* Preview). Anything left unset degrades gracefully — the feature simply
stays off — except `CRON_SECRET`, which the crons need to run at all.

| Variable | Required | What breaks without it |
|---|---|---|
| `CRON_SECRET` | **yes** | Every `/api/cron/*` route returns 401. Stale credit reservations are never released and the admin snapshot is never refreshed. |
| `UPSTASH_REDIS_REST_URL` | recommended | Rate limiting falls back to per-instance memory, so the real limit is `configured_limit × instance_count`. |
| `UPSTASH_REDIS_REST_TOKEN` | recommended | Same as above; both are needed together. |
| `NEXT_PUBLIC_SENTRY_DSN` | recommended | No error reporting. Paid-scan failures stay invisible. |
| `SENTRY_ORG` | optional | Source maps aren't uploaded; stack traces stay minified. |
| `SENTRY_PROJECT` | optional | Same. |
| `SENTRY_AUTH_TOKEN` | optional | Same. |
| `NEXT_PUBLIC_SITE_URL` | recommended | Canonical URLs, OG tags, `robots.txt` and `sitemap.xml` fall back to `https://www.alphawallets.fun` (see `src/lib/siteUrl.ts`). |

Generate `CRON_SECRET` with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

`.env.local.example` documents all of them for local development. Note that
`.env.local` has no trailing newline — edit it in an editor, not with `>>`.

### `DATABASE_URL` must stay the pooled string

`DATABASE_URL` / `POSTGRES_URL` must be the Supabase **transaction pooler**
connection (port `6543`, `*.pooler.supabase.com`). `POSTGRES_URL_NON_POOLING`
(port `5432`) is for migrations only. The app sets `prepare: false` because the
pooler does not support prepared statements.

The pool is `max: 3`. Do not lower it to 1: `postgres.js` pipelines queries onto
its connections, and when a fan-out outruns the pool the Supabase pooler stops
answering entirely — requests hang until the platform kills them. See the comment
in `src/lib/db/index.ts`.

## 2. Database migrations

Three migrations were added. **All three are already applied to the live Supabase
database** (verified against production on 2026-08-20: both columns, the table and
both indexes are present).

| File | Change | Why |
|---|---|---|
| `drizzle/0014_credit_reservation.sql` | `scan_credits.reserved_at timestamptz` + index | Marks a credit as claimed-but-not-yet-delivered, so a scan killed mid-flight can be swept and handed back instead of silently costing the buyer their purchase. |
| `drizzle/0015_stats_snapshot.sql` | `stats_snapshot` table; `wallet_tokens (wallet_id, realized_pnl_usd desc)` index | The admin dashboard reads one JSONB row instead of recomputing eleven aggregates. The index covers the rewritten top-5-wins lateral join in `src/lib/db/history.ts`. |
| `drizzle/0016_token_supply.sql` | `tokens.estimated_supply double precision` | Market-cap maths reads supply from the server instead of trusting a client-supplied query parameter. |

Every statement is `IF NOT EXISTS`, so re-running them is safe.

If you are deploying to a **fresh** database, apply them with the direct
(non-pooled) connection:

```bash
psql "$POSTGRES_URL_NON_POOLING" -f drizzle/0014_credit_reservation.sql
psql "$POSTGRES_URL_NON_POOLING" -f drizzle/0015_stats_snapshot.sql
psql "$POSTGRES_URL_NON_POOLING" -f drizzle/0016_token_supply.sql
```

`drizzle-kit generate` is **not** safe in this repo — `drizzle/meta` only tracks
as far as `0001`, so it would try to recreate the whole schema. Hand-write
migrations and apply them directly, which is what the existing files do.

`stats_snapshot` starts empty. That is fine: `/api/admin/stats` computes the
figures inline whenever the snapshot is missing or older than ten minutes, and
the cron fills it in within a minute of the first deploy.

## 3. Cron jobs

Both are declared in `vercel.json` and register automatically on deploy. Vercel
sends `Authorization: Bearer $CRON_SECRET`, which `src/lib/cronAuth.ts` checks in
constant time.

| Path | Schedule | Purpose |
|---|---|---|
| `/api/cron/release-stale-credits` | `*/5 * * * *` | Releases any credit still holding `reserved_at` after 10 minutes. The safety net for every timeout, crash or deploy that interrupts a scan after the credit was reserved. |
| `/api/cron/refresh-stats` | `* * * * *` | Recomputes the admin dashboard snapshot. Takes ~0.3s. |

Cron jobs on Vercel run against **production** only. Verify after deploying:

```bash
curl -s -H "authorization: Bearer $CRON_SECRET" https://<domain>/api/cron/release-stale-credits
# -> {"released":0}
curl -s -H "authorization: Bearer $CRON_SECRET" https://<domain>/api/cron/refresh-stats
# -> {"refreshed":true}
curl -s -o /dev/null -w '%{http_code}\n' https://<domain>/api/cron/refresh-stats
# -> 401
```

## 4. Function duration

`/api/top-traders` and `/api/wallet-detail` declare `maxDuration = 300`, which
requires **Vercel Pro**; Hobby caps at 60s no matter what is declared. Paging is
additionally bounded by `SCAN_BUDGET_MS = 180_000` in
`src/app/api/top-traders/route.ts`, leaving two minutes for on-chain holdings,
history and serialisation. If the plan ever changes, lower the budget to stay
inside the platform ceiling — a scan that gets killed after the credit is
reserved is the failure mode all of this exists to prevent.

## 5. Post-deploy checklist

- [ ] `CRON_SECRET` set; both cron URLs return 200 with the bearer and 401 without it.
- [ ] `/admin` loads and `ADMIN_PASSWORD` is set (without it the login route returns 503).
- [ ] `/api/admin/stats` responds in well under a second once `refresh-stats` has run.
- [ ] A real paid scan on each chain delivers wallets and clears `reserved_at`:
      `select claim_token, consumed_at, reserved_at from scan_credits order by created_at desc limit 5;`
- [ ] `select count(*) from scan_credits where reserved_at < now() - interval '10 minutes';`
      stays at 0 — anything else means the sweeper is not running.
- [ ] `/robots.txt`, `/sitemap.xml` and the OG image resolve against the real domain.
