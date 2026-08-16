// Shows wallets seen across multiple tokens — the core "is this wallet consistently
// profitable" signal the database exists to answer.
import postgres from "postgres";

const sql = postgres(process.env.POSTGRES_URL_NON_POOLING || process.env.POSTGRES_URL, {
  prepare: false,
});

const [{ c: tokenCount }] = await sql`select count(*)::int as c from tokens`;
console.log(`tokens scanned: ${tokenCount}\n`);

const repeats = await sql`
  select w.address, w.chain, w.times_seen, w.is_bot, w.lifetime_pnl_usd,
         count(distinct wt.token_id)::int as tokens_hit,
         sum(wt.realized_pnl_usd) as total_pnl,
         max(wt.multiple_x) as best_x
  from wallets w
  join wallet_tokens wt on wt.wallet_id = w.id
  group by w.id
  having count(distinct wt.token_id) > 1
  order by tokens_hit desc, total_pnl desc
  limit 10
`;

if (repeats.length === 0) {
  console.log("No wallets yet appear on more than one token.");
} else {
  console.log("--- wallets on multiple tokens ---");
  for (const r of repeats) {
    const wins = await sql`
      select t.symbol, wt.realized_pnl_usd, wt.multiple_x
      from wallet_tokens wt join tokens t on t.id = wt.token_id
      where wt.wallet_id = (select id from wallets where address = ${r.address} and chain = ${r.chain})
      order by wt.realized_pnl_usd desc
    `;
    const tags = wins
      .map((w) => `${Math.round(w.realized_pnl_usd / 1000)}K[${(w.multiple_x ?? 0).toFixed(0)}X] $${w.symbol}`)
      .join(", ");
    console.log(`${r.address.slice(0, 8)}… seen=${r.times_seen} tokens=${r.tokens_hit}${r.is_bot ? " BOT" : ""}`);
    console.log(`   ${tags}`);
  }
}
await sql.end();
