/**
 * One-off: fills tokens.native_price_usd for rows scanned before the column
 * existed. Uses one live price call per chain (current spot), so the ticker's
 * native-currency toggle shows a real conversion instead of nothing.
 */
import postgres from "postgres";

const url =
  process.env.POSTGRES_URL_NON_POOLING || process.env.POSTGRES_URL || process.env.DATABASE_URL;
if (!url) throw new Error("POSTGRES_URL not set");

const WRAPPED = {
  solana: "So11111111111111111111111111111111111111112",
  bsc: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c",
  base: "0x4200000000000000000000000000000000000006",
  robinhood: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",
};

async function solPrice() {
  const key = process.env.SOLANA_TRACKER_API_KEY;
  if (!key) return 0;
  const res = await fetch(`https://data.solanatracker.io/price?token=${WRAPPED.solana}`, {
    headers: { "x-api-key": key },
  });
  if (!res.ok) return 0;
  const d = await res.json();
  return d.price ?? 0;
}

async function evmPrice(chain) {
  const key = process.env.BIRDEYE_API_KEY;
  if (!key) return 0;
  const res = await fetch(`https://public-api.birdeye.so/defi/price?address=${WRAPPED[chain]}`, {
    headers: { "X-API-KEY": key, "x-chain": chain },
  });
  if (!res.ok) return 0;
  const d = await res.json();
  return d?.data?.value ?? 0;
}

const sql = postgres(url, { prepare: false, max: 2 });

try {
  const prices = {
    solana: await solPrice(),
    bsc: await evmPrice("bsc"),
    base: await evmPrice("base"),
    robinhood: await evmPrice("robinhood"),
  };
  console.log("native prices:", prices);

  for (const [chain, price] of Object.entries(prices)) {
    if (!price) {
      console.log(`skip ${chain}: no price`);
      continue;
    }
    const rows = await sql`
      update tokens set native_price_usd = ${price}
      where chain = ${chain} and native_price_usd is null
      returning symbol`;
    console.log(`${chain}: updated ${rows.length}`, rows.map((r) => r.symbol).join(", "));
  }
} finally {
  await sql.end();
}
