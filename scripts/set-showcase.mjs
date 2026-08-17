/**
 * Controls which cached tokens are offered as free samples.
 *
 *   node scripts/set-showcase.mjs              # list current state
 *   node scripts/set-showcase.mjs on  BONK ZEREBRO
 *   node scripts/set-showcase.mjs off BONK
 *
 * Customer-scanned tokens stay off by default, so nobody gets a paid scan free.
 */
import postgres from "postgres";

const url =
  process.env.POSTGRES_URL_NON_POOLING || process.env.POSTGRES_URL || process.env.DATABASE_URL;
if (!url) throw new Error("POSTGRES_URL not set");

const [mode, ...symbols] = process.argv.slice(2);
const sql = postgres(url, { prepare: false, max: 2 });

try {
  if (mode === "on" || mode === "off") {
    if (symbols.length === 0) throw new Error(`usage: set-showcase.mjs ${mode} SYMBOL [SYMBOL...]`);
    const rows = await sql`
      update tokens set showcase = ${mode === "on"}
      where upper(symbol) = any(${symbols.map((s) => s.toUpperCase())})
      returning symbol, chain, showcase`;
    if (rows.length === 0) console.log("no tokens matched:", symbols.join(", "));
    for (const r of rows) console.log(`${r.showcase ? "ON " : "OFF"} ${r.symbol} (${r.chain})`);
  }

  const all = await sql`
    select t.symbol, t.chain, t.showcase, count(wt.wallet_id)::int as wallets
    from tokens t left join wallet_tokens wt on wt.token_id = t.id
    group by t.id order by t.showcase desc, wallets desc`;
  console.log("\nsymbol      chain   wallets  free sample");
  for (const r of all) {
    console.log(
      `${(r.symbol ?? "?").padEnd(11)} ${r.chain.padEnd(7)} ${String(r.wallets).padEnd(8)} ${
        r.showcase ? "YES" : "no"
      }`
    );
  }
} finally {
  await sql.end();
}
