// Quick inspection helper: prints row counts and the current top wallets.
import postgres from "postgres";

const url = process.env.POSTGRES_URL_NON_POOLING || process.env.POSTGRES_URL;
const sql = postgres(url, { prepare: false });

for (const t of ["tokens", "wallets", "observations", "wallet_tokens"]) {
  const [{ c }] = await sql.unsafe(`select count(*)::int as c from ${t}`);
  console.log(t.padEnd(15), c);
}

const top = await sql`
  select w.address, w.chain, wt.realized_pnl_usd, wt.multiple_x,
         w.lifetime_pnl_usd, w.is_bot, w.times_seen
  from wallet_tokens wt
  join wallets w on w.id = wt.wallet_id
  order by wt.realized_pnl_usd desc
  limit 5
`;
console.log("\n--- top wallets ---");
for (const r of top) {
  const pnl = Math.round(r.realized_pnl_usd).toLocaleString();
  const life = r.lifetime_pnl_usd == null ? "n/a" : Math.round(r.lifetime_pnl_usd).toLocaleString();
  console.log(
    `${r.address.slice(0, 8)}… ${r.chain.padEnd(7)} pnl=$${pnl.padStart(10)} ` +
      `${(r.multiple_x ?? 0).toFixed(1)}x lifetime=$${life} seen=${r.times_seen}${r.is_bot ? " BOT" : ""}`
  );
}
await sql.end();
