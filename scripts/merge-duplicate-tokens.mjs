/**
 * Corrective backfill: one token, one row.
 *
 * `tokens` is keyed on `(chain, address)` and that index is case-sensitive, but
 * an EVM address is not. The token address comes from whatever a buyer pastes,
 * so the same contract arriving once checksummed and once lowercased minted two
 * rows — each accumulating its own `wallet_tokens` history. Measured against the
 * live database, three BNB Chain tokens had already split this way, including
 * the one flagged `showcase = true`, whose free sample was therefore serving 260
 * traders while 76 more sat on the twin row, invisible.
 *
 * `normalizeAddress` in `src/lib/chains.ts` now lowercases EVM addresses on the
 * way in, so no new split can form. This is the other half: it merges the splits
 * that already exist and lowercases what is left. **It must run AFTER that fix is
 * deployed** — otherwise the next scan re-creates a checksummed row. Same
 * ordering as `unflag-false-bots.mjs`, and for the same reason.
 *
 * Solana is untouched throughout. Base58 is case-sensitive; lowercasing a mint
 * address would produce a different, wrong address.
 *
 * The merge mirrors the windowed `on conflict` rules in `recordScan` exactly, so
 * a merged row is what the database would have held had the two casings landed
 * on one row in the first place: PNL takes the greater, the descriptive columns
 * follow whichever side won on PNL, position size follows whichever was seen
 * last, `best_rank` takes the better and `times_observed` sums.
 *
 * Everything runs in one transaction and asserts the row count it expects before
 * committing, so a surprise rolls the whole thing back rather than leaving the
 * archive half-merged.
 *
 * Usage:
 *   node --env-file=.env.local scripts/merge-duplicate-tokens.mjs           # report
 *   node --env-file=.env.local scripts/merge-duplicate-tokens.mjs --apply
 */
import fs from "node:fs";
import postgres from "postgres";

const url = process.env.POSTGRES_URL_NON_POOLING || process.env.POSTGRES_URL;
if (!url) {
  console.error("No POSTGRES_URL_NON_POOLING / POSTGRES_URL in env.");
  process.exit(1);
}

const apply = process.argv.includes("--apply");
const EVM_CHAINS = ["bsc", "base"];

// One statement at a time, never a fan-out: postgres.js pipelines concurrent
// queries and a fan-out wider than the pool hangs against Supabase's pooler.
const sql = postgres(url, { prepare: false, max: 1 });

/** Which of a duplicate pair survives: the showcase row first, because that flag
 *  is hand-curated and the free sample points at it; then the row already
 *  carrying the most history, because that is the least data to move; then the
 *  oldest, as a stable tie-break. Address casing does not decide this — the
 *  survivor gets lowercased at the end regardless. */
function pickSurvivor(rows) {
  return [...rows].sort(
    (a, b) =>
      Number(b.showcase) - Number(a.showcase) ||
      b.trader_rows - a.trader_rows ||
      a.id - b.id
  )[0];
}

try {
  const groups = await sql`
    select chain, lower(address) as addr
    from tokens
    where chain = any(${EVM_CHAINS})
    group by 1, 2
    having count(*) > 1
    order by 1, 2`;

  const [mixed] = await sql`
    select count(*)::int as n from tokens
    where chain = any(${EVM_CHAINS}) and address <> lower(address)`;

  const [before] = await sql`select count(*)::int as n from wallet_tokens`;

  console.log(
    `Rule: one tokens row per (chain, lowercased address)   ` +
      `[${apply ? "APPLY" : "REPORT ONLY — pass --apply to write"}]\n`
  );
  console.log(`tokens — ${mixed.n} EVM rows stored with mixed case`);
  console.log(`         ${groups.length} address(es) split across two rows\n`);

  // Resolve every group up front so the report and the write agree on the plan.
  const plans = [];
  for (const g of groups) {
    const rows = await sql`
      select t.id, t.address, t.symbol, t.showcase, t.scan_count,
             (select count(*)::int from wallet_tokens wt where wt.token_id = t.id) as trader_rows
      from tokens t
      where t.chain = ${g.chain} and lower(t.address) = ${g.addr}
      order by t.id`;
    const survivor = pickSurvivor(rows);
    const losers = rows.filter((r) => r.id !== survivor.id);

    let overlap = 0;
    let moved = 0;
    for (const l of losers) {
      const [o] = await sql`
        select count(*)::int as n from wallet_tokens l
        where l.token_id = ${l.id}
          and exists (select 1 from wallet_tokens s
                      where s.token_id = ${survivor.id} and s.wallet_id = l.wallet_id)`;
      overlap += o.n;
      moved += l.trader_rows - o.n;
    }

    plans.push({ chain: g.chain, addr: g.addr, survivor, losers, overlap, moved });

    console.log(`${g.chain} ${g.addr}  ${survivor.symbol ?? "?"}`);
    console.log(
      `  keep   id=${survivor.id} ${survivor.address}` +
        `${survivor.showcase ? " [showcase]" : ""}  wallet_tokens=${survivor.trader_rows}`
    );
    for (const l of losers) {
      console.log(`  merge  id=${l.id} ${l.address}  wallet_tokens=${l.trader_rows}`);
    }
    console.log(`  -> ${plans.at(-1).moved} row(s) move, ${overlap} merge into an existing row`);
  }

  const expectedLoss = plans.reduce((a, p) => a + p.overlap, 0);
  console.log(
    `\nwallet_tokens — ${before.n} now, ${before.n - expectedLoss} after ` +
      `(${expectedLoss} pairs collapse into one row each; no history is discarded)`
  );

  if (!apply) {
    console.log("\nDry run. Nothing written. Re-run with --apply.");
    await sql.end();
    process.exit(0);
  }

  if (groups.length === 0 && mixed.n === 0) {
    console.log("\nAlready clean. Nothing to do.");
    await sql.end();
    process.exit(0);
  }

  /* -- pre-state dump ------------------------------------------------------ */
  // Cheap insurance: every row this script can touch, written out before the
  // transaction opens, so the merge is reversible by hand if it turns out wrong.
  if (plans.length > 0) {
    const ids = plans.flatMap((p) => [p.survivor.id, ...p.losers.map((l) => l.id)]);
    const tokenRows = await sql`select * from tokens where id = any(${ids})`;
    const wtRows = await sql`select * from wallet_tokens where token_id = any(${ids})`;
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const path = `backup-merge-tokens-${stamp}.json`;
    fs.writeFileSync(path, JSON.stringify({ tokens: tokenRows, wallet_tokens: wtRows }, null, 2));
    console.log(`\nwrote ${path} — ${tokenRows.length} tokens, ${wtRows.length} wallet_tokens`);
  }

  /* -- apply --------------------------------------------------------------- */
  const result = await sql.begin(async (tx) => {
    let merged = 0;
    let moved = 0;

    for (const p of plans) {
      for (const l of p.losers) {
        // Same rules as the windowed `on conflict` in recordScan: greater PNL
        // wins, and the descriptive columns follow whichever side won on PNL.
        const m = await tx`
          update wallet_tokens s set
            best_rank = least(coalesce(s.best_rank, 2147483647), coalesce(l.best_rank, 2147483647)),
            last_rank = case when l.last_observed_at > s.last_observed_at then l.last_rank else s.last_rank end,
            last_trade_ms = greatest(coalesce(s.last_trade_ms, 0), coalesce(l.last_trade_ms, 0)),
            realized_pnl_usd = greatest(s.realized_pnl_usd, l.realized_pnl_usd),
            roi_percent      = case when l.realized_pnl_usd > s.realized_pnl_usd then l.roi_percent      else s.roi_percent end,
            multiple_x       = case when l.realized_pnl_usd > s.realized_pnl_usd then l.multiple_x       else s.multiple_x end,
            avg_buy_price_usd  = case when l.realized_pnl_usd > s.realized_pnl_usd then l.avg_buy_price_usd  else s.avg_buy_price_usd end,
            avg_sell_price_usd = case when l.realized_pnl_usd > s.realized_pnl_usd then l.avg_sell_price_usd else s.avg_sell_price_usd end,
            avg_buy_mcap_usd   = case when l.realized_pnl_usd > s.realized_pnl_usd then l.avg_buy_mcap_usd   else s.avg_buy_mcap_usd end,
            avg_sell_mcap_usd  = case when l.realized_pnl_usd > s.realized_pnl_usd then l.avg_sell_mcap_usd  else s.avg_sell_mcap_usd end,
            bought_usd         = case when l.realized_pnl_usd > s.realized_pnl_usd then l.bought_usd         else s.bought_usd end,
            proceeds_usd       = case when l.realized_pnl_usd > s.realized_pnl_usd then l.proceeds_usd       else s.proceeds_usd end,
            -- Position size is only meaningful as of the latest look.
            remaining_percent   = case when l.last_observed_at > s.last_observed_at then l.remaining_percent   else s.remaining_percent end,
            remaining_value_usd = case when l.last_observed_at > s.last_observed_at then l.remaining_value_usd else s.remaining_value_usd end,
            unrealized_pnl_usd  = case when l.last_observed_at > s.last_observed_at then l.unrealized_pnl_usd  else s.unrealized_pnl_usd end,
            ranking_window      = case when l.last_observed_at > s.last_observed_at then l.ranking_window      else s.ranking_window end,
            times_observed = coalesce(s.times_observed, 0) + coalesce(l.times_observed, 0),
            first_observed_at = least(s.first_observed_at, l.first_observed_at),
            last_observed_at  = greatest(s.last_observed_at, l.last_observed_at)
          from wallet_tokens l
          where s.token_id = ${p.survivor.id}
            and l.token_id = ${l.id}
            and l.wallet_id = s.wallet_id
          returning s.wallet_id`;
        merged += m.length;

        // The rows just folded in are now duplicated; drop them before moving
        // the remainder, or the token_id update would violate the primary key.
        await tx`
          delete from wallet_tokens l
          where l.token_id = ${l.id}
            and exists (select 1 from wallet_tokens s
                        where s.token_id = ${p.survivor.id} and s.wallet_id = l.wallet_id)`;

        const mv = await tx`
          update wallet_tokens set token_id = ${p.survivor.id}
          where token_id = ${l.id}
          returning wallet_id`;
        moved += mv.length;

        // Fold the loser's own counters in. `scan_count` is a sum because each
        // row really was scanned that many times; the buyer paid for both.
        await tx`
          update tokens t set
            scan_count = t.scan_count + ${l.scan_count ?? 0},
            showcase = t.showcase or ${l.showcase},
            last_scanned_at = greatest(t.last_scanned_at, (select last_scanned_at from tokens where id = ${l.id})),
            symbol = coalesce(t.symbol, (select symbol from tokens where id = ${l.id})),
            name = coalesce(t.name, (select name from tokens where id = ${l.id})),
            image_url = coalesce(t.image_url, (select image_url from tokens where id = ${l.id}))
          where t.id = ${p.survivor.id}`;

        await tx`delete from tokens where id = ${l.id}`;
      }
    }

    // Anything still checksummed, survivors included. Safe now: the merge above
    // removed every case-collision, so no unique violation is possible.
    const lowered = await tx`
      update tokens set address = lower(address)
      where chain = any(${EVM_CHAINS}) and address <> lower(address)
      returning id`;

    // Refuse to commit unless the arithmetic is exactly what was reported.
    const [after] = await tx`select count(*)::int as n from wallet_tokens`;
    if (after.n !== before.n - expectedLoss) {
      throw new Error(
        `wallet_tokens is ${after.n}, expected ${before.n - expectedLoss}. Rolled back.`
      );
    }
    const [stillSplit] = await tx`
      select count(*)::int as n from (
        select chain, lower(address) from tokens where chain = any(${EVM_CHAINS})
        group by 1, 2 having count(*) > 1) t`;
    if (stillSplit.n !== 0) throw new Error(`${stillSplit.n} split addresses remain. Rolled back.`);

    return { merged, moved, lowered: lowered.length, after: after.n };
  });

  console.log(
    `\nmerged ${result.merged} overlapping row(s), moved ${result.moved}, ` +
      `lowercased ${result.lowered} token address(es)`
  );
  console.log(`wallet_tokens now ${result.after}`);
} finally {
  await sql.end();
}
