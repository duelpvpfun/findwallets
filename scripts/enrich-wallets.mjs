// Enriches wallets already in our database with their trades on OTHER tokens,
// then stamps each wallet with badges in the form `[27X] $42.1K $WIF`.
//
// Why this exists: `wallet_tokens` only holds tokens somebody paid to scan, so a
// wallet's real track record is invisible to us — a top-50 placing looks the
// same whether the wallet is a serial winner or got lucky once. GMGN's free API
// returns a wallet's whole position history in one call, which our paid
// upstreams do not.
//
// Long-running and resumable: it processes least-recently-enriched wallets
// first, commits after each wallet, and re-reads its queue every pass, so a
// disconnected Codespace costs at most one wallet and newly scanned wallets get
// picked up automatically without a restart.
//
// Usage:
//   node --env-file=.env.local scripts/enrich-wallets.mjs            # run forever
//   node --env-file=.env.local scripts/enrich-wallets.mjs --limit 20 # one batch, then exit
//   node --env-file=.env.local scripts/enrich-wallets.mjs --force    # re-enrich everything
//   node --env-file=.env.local scripts/enrich-wallets.mjs --dry-run  # fetch + print, write nothing

import postgres from "postgres";
import { GMGN_CHAIN, GmgnRateLimitError, createClient } from "./lib/gmgn.mjs";

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const value = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const DRY_RUN = flag("dry-run");
const FORCE = flag("force");
const ONCE = args.includes("--limit");
const BATCH = Number(value("limit", 25));
// Must match MIN_WALLET_* in src/lib/quality.ts — the same bar the scan route
// applies, so a tag can never claim a win the rest of the database would reject.
// It gates BADGES, not storage: every position is written, carrying its verdict.
const MIN_BADGE_PNL_USD = Number(value("min-pnl", 1000));
const MIN_BADGE_MULTIPLE = Number(value("min-x", 2));
// How many tags render inline. The rest stay in the column and surface behind
// the "…" overflow, so nothing discovered is lost.
const MAX_BADGES = Number(value("badges", 3));
const STALE_DAYS = Number(value("stale-days", 14));
// Matches MIN_COST_BASIS_USD in src/lib/quality.ts: below this the basis is dust
// left over from an untracked transfer, and the multiple is meaningless.
const MIN_COST_BASIS_USD = 100;
// Upstream returns positions like $102B profit on a $360 buy (283,265,921x) —
// almost certainly a price feed on an illiquid pool. No real trade looks like
// this, so the row is stored as `implausible` rather than badged as a win.
const MAX_PLAUSIBLE_MULTIPLE = 500;
const MAX_PLAUSIBLE_PNL_USD = 100_000_000;

const url = process.env.POSTGRES_URL_NON_POOLING || process.env.POSTGRES_URL;
if (!url) {
  console.error("No POSTGRES_URL_NON_POOLING / POSTGRES_URL in env.");
  process.exit(1);
}

const sql = postgres(url, { ssl: "require", prepare: false });
const gmgn = createClient();

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

function formatUsd(v) {
  const abs = Math.abs(v);
  const sign = v < 0 ? "-" : "";
  if (abs >= 1_000_000_000) return `${sign}$${(abs / 1_000_000_000).toFixed(2)}B`;
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(1)}K`;
  if (abs >= 1) return `${sign}$${abs.toFixed(2)}`;
  return `${sign}$${abs.toFixed(abs === 0 ? 0 : 6)}`;
}

// Must stay identical to formatWinBadge() in src/lib/format.ts.
function formatWinBadge(multipleX, pnlUsd, symbol) {
  const ticker = String(symbol || "").replace(/^\$+/, "").trim() || "?";
  return `[${Math.round(multipleX)}X] ${formatUsd(pnlUsd)} $${ticker}`;
}

/**
 * Flatten one GMGN holdings item into a wallet_positions row. Every numeric
 * field arrives as a string, and the token key is `token_address`, not
 * `address`.
 */
function toPosition(item, chain) {
  const token = item.token || {};
  const address = token.token_address || token.address;
  if (!address) return null;

  const realized = num(item.realized_profit) ?? 0;
  const unrealized = num(item.unrealized_profit) ?? 0;
  const bought = num(item.history_bought_cost) ?? 0;
  const total = num(item.total_profit) ?? realized + unrealized;
  const buys = num(item.history_total_buys) ?? 0;

  return {
    chain,
    tokenAddress: address,
    symbol: token.symbol ?? null,
    name: token.name ?? null,
    realizedPnlUsd: realized,
    unrealizedPnlUsd: unrealized,
    totalPnlUsd: total,
    boughtUsd: bought,
    soldUsd: num(item.history_sold_income),
    // Requires a real buy AND a basis worth dividing by: tokens that arrived by
    // transfer carry only dust as their tracked cost, which reads as 283,265,921x.
    multipleX: bought >= MIN_COST_BASIS_USD && buys > 0 ? 1 + total / bought : null,
    avgCostUsd: bought > 0 && num(item.history_bought_amount)
      ? bought / num(item.history_bought_amount)
      : null,
    balance: num(item.balance),
    valueUsd: num(item.usd_value),
    buyTxCount: buys,
    sellTxCount: num(item.history_total_sells) ?? 0,
    lastTradeMs: num(item.last_active_timestamp) ? num(item.last_active_timestamp) * 1000 : null,
  };
}

/**
 * Why a position isn't a win, or null when it is. Mirrors `qualityVerdict` in
 * src/lib/quality.ts, with the two extra plausibility bounds this worker needs
 * because GMGN will happily report $102B profit on a $360 buy.
 *
 * Every position is stored either way. Dropping the losses is what made a
 * wallet's GMGN history read as an unbroken run of wins.
 */
function disqualifiedReason(p) {
  if (!p.symbol) return "no_symbol";
  if (p.multipleX === null) return "no_multiple";
  if (!Number.isFinite(p.multipleX) || !Number.isFinite(p.totalPnlUsd)) return "not_finite";
  if (p.totalPnlUsd > MAX_PLAUSIBLE_PNL_USD || p.multipleX > MAX_PLAUSIBLE_MULTIPLE) {
    return "implausible";
  }
  const belowMultiple = p.multipleX < MIN_BADGE_MULTIPLE;
  const belowPnl = p.totalPnlUsd < MIN_BADGE_PNL_USD;
  if (belowMultiple && belowPnl) return "below_both";
  if (belowMultiple) return "below_multiple";
  if (belowPnl) return "below_pnl";
  return null;
}

/** Tags every position with its verdict, in place. */
function judge(positions) {
  for (const p of positions) {
    const reason = disqualifiedReason(p);
    p.qualified = reason === null;
    p.disqualifiedReason = reason;
  }
  return positions;
}

/** Every win clearing the bar, biggest first. The UI decides how many to show. */
function qualifyingWins(positions) {
  return positions.filter((p) => p.qualified).sort((a, b) => b.totalPnlUsd - a.totalPnlUsd);
}

async function claimQueue() {
  const staleBefore = new Date(Date.now() - STALE_DAYS * 86_400_000);
  if (FORCE) {
    return sql`
      select id, chain, address from wallets
      where chain in ('solana', 'bsc', 'base')
      order by enriched_at asc nulls first, id asc
      limit ${BATCH}`;
  }
  return sql`
    select id, chain, address from wallets
    where chain in ('solana', 'bsc', 'base')
      and (enriched_at is null or enriched_at < ${staleBefore})
    order by enriched_at asc nulls first, id asc
    limit ${BATCH}`;
}

async function persist(wallet, positions, badges) {
  await sql.begin(async (tx) => {
    if (positions.length > 0) {
      await tx`
        insert into wallet_positions ${tx(
          positions.map((p) => ({
            wallet_id: wallet.id,
            chain: p.chain,
            token_address: p.tokenAddress,
            symbol: p.symbol,
            name: p.name,
            realized_pnl_usd: p.realizedPnlUsd,
            unrealized_pnl_usd: p.unrealizedPnlUsd,
            total_pnl_usd: p.totalPnlUsd,
            bought_usd: p.boughtUsd,
            sold_usd: p.soldUsd,
            multiple_x: p.multipleX,
            avg_cost_usd: p.avgCostUsd,
            balance: p.balance,
            value_usd: p.valueUsd,
            buy_tx_count: p.buyTxCount,
            sell_tx_count: p.sellTxCount,
            last_trade_ms: p.lastTradeMs,
            qualified: p.qualified,
            disqualified_reason: p.disqualifiedReason,
            fetched_at: new Date(),
          }))
        )}
        on conflict (wallet_id, token_address) do update set
          symbol = excluded.symbol,
          name = excluded.name,
          realized_pnl_usd = excluded.realized_pnl_usd,
          unrealized_pnl_usd = excluded.unrealized_pnl_usd,
          total_pnl_usd = excluded.total_pnl_usd,
          bought_usd = excluded.bought_usd,
          sold_usd = excluded.sold_usd,
          multiple_x = excluded.multiple_x,
          avg_cost_usd = excluded.avg_cost_usd,
          balance = excluded.balance,
          value_usd = excluded.value_usd,
          buy_tx_count = excluded.buy_tx_count,
          sell_tx_count = excluded.sell_tx_count,
          last_trade_ms = excluded.last_trade_ms,
          qualified = excluded.qualified,
          disqualified_reason = excluded.disqualified_reason,
          fetched_at = excluded.fetched_at`;
    }

    await tx`
      update wallets
      set win_badges = ${badges}, enriched_at = now()
      where id = ${wallet.id}`;
  });
}

let processed = 0;
let failed = 0;
let badged = 0;

console.log(
  `enrich-wallets: batch=${BATCH} min-pnl=${formatUsd(MIN_BADGE_PNL_USD)} min-x=${MIN_BADGE_MULTIPLE} badges=${MAX_BADGES}${DRY_RUN ? " [DRY RUN]" : ""}${FORCE ? " [FORCE]" : ""}`
);

let stop = false;
let wakeFromIdle = null;
process.on("SIGINT", () => {
  if (stop) process.exit(130);
  console.log("\nstopping after current wallet... (Ctrl-C again to force)");
  stop = true;
  // Idle waits are minutes long, so the flag alone would leave Ctrl-C looking
  // dead until the timer expired.
  if (wakeFromIdle) wakeFromIdle();
});

/** Sleep that returns early when a stop has been requested. */
function idle(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    wakeFromIdle = () => {
      clearTimeout(timer);
      resolve();
    };
  }).finally(() => {
    wakeFromIdle = null;
  });
}

for (;;) {
  if (stop) break;
  const queue = await claimQueue();

  if (queue.length === 0) {
    if (ONCE) break;
    console.log("queue empty, sleeping 60s (Ctrl-C to stop; new wallets get picked up automatically)");
    await idle(60_000);
    continue;
  }

  for (const wallet of queue) {
    if (stop) break;

    const chain = GMGN_CHAIN[wallet.chain];
    if (!chain) continue;

    try {
      const data = await gmgn.walletHoldings(chain, wallet.address, {
        limit: 50,
        orderBy: "total_profit",
      });

      const list = data?.holdings || data?.list || (Array.isArray(data) ? data : []);
      const positions = judge(list.map((i) => toPosition(i, wallet.chain)).filter(Boolean));
      // Every position is stored, flagged. Only the wins earn a badge — a badge
      // is a claim about the wallet, whereas a stored loss is just the truth.
      const wins = qualifyingWins(positions);
      const badges = wins.map((p) => formatWinBadge(p.multipleX, p.totalPnlUsd, p.symbol));

      if (badges.length > 0) badged++;
      processed++;

      const shown = badges.slice(0, MAX_BADGES).join("  ");
      const extra = badges.length > MAX_BADGES ? ` +${badges.length - MAX_BADGES}` : "";
      const summary = `${wallet.address.slice(0, 6)}… ${positions.length} pos (${wins.length} win) → ${shown || "(no qualifying win)"}${extra}`;

      if (DRY_RUN) {
        console.log(summary);
      } else {
        await persist(wallet, positions, badges);
        console.log(`[${processed}] ${summary}`);
      }
    } catch (err) {
      if (err instanceof GmgnRateLimitError) {
        const waitMs = err.resetAtUnix
          ? Math.max(1000, err.resetAtUnix * 1000 - Date.now() + 1000)
          : 30_000;
        console.warn(`rate limited, waiting ${Math.ceil(waitMs / 1000)}s (not retrying in cooldown)`);
        await idle(waitMs);
        continue;
      }
      failed++;
      console.warn(`FAIL ${wallet.address.slice(0, 6)}…: ${err.message}`);
      if (!DRY_RUN) {
        // Stamp it anyway so one permanently broken wallet can't wedge the queue.
        await sql`update wallets set enriched_at = now() where id = ${wallet.id}`;
      }
      if (/GMGN_API_KEY|needs a signature/.test(err.message)) break;
    }
  }

  if (stop || ONCE) break;
}

console.log(
  `done: processed=${processed} badged=${badged} failed=${failed} gmgn_calls=${gmgn.callCount}`
);
await sql.end();
