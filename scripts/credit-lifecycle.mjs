/**
 * Exercises the whole paid-credit lifecycle against a running server and the
 * real database: reserve, deliver, retry while in flight, retry after a crash,
 * and the cron sweeper. Run it before trusting any change to
 * src/lib/db/credits.ts, src/lib/access.ts or the scan route.
 *
 * It creates and deletes its own throwaway credit row (payment_id prefixed
 * TESTONLY-) and never touches a real purchase. It does run one genuine scan,
 * so it spends upstream API credits.
 *
 *   npm run dev
 *   env -u DATABASE_URL node --env-file=.env.local scripts/credit-lifecycle.mjs
 *
 * Requires PAYMENTS_ENABLED=true (otherwise every scan is free and no credit is
 * ever reserved) and CRON_SECRET for the sweeper step.
 */
import postgres from "postgres";

const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const sql = postgres(process.env.POSTGRES_URL ?? process.env.DATABASE_URL, {
  prepare: false,
  max: 1,
  idle_timeout: 5,
});

if (process.env.PAYMENTS_ENABLED !== "true") {
  console.error("PAYMENTS_ENABLED is not 'true' — scans would be free and nothing would reserve.");
  process.exit(1);
}

const CLAIM = `lifecycle-test-${Date.now()}`;
const PAYMENT_ID = `TESTONLY-${CLAIM}`;
let failures = 0;

const check = (label, actual, expected) => {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}: ${actual}${ok ? "" : ` (expected ${expected})`}`);
};

const row = async () =>
  (
    await sql`select consumed_at, reserved_at, consumed_chain, consumed_token_address
              from scan_credits where claim_token = ${CLAIM}`
  )[0];

const [token] = await sql`
  select address from tokens where chain = 'solana' order by last_scanned_at desc nulls last limit 1`;
if (!token) {
  console.error("No solana token in the database to scan. Run a scan first.");
  process.exit(1);
}

const scan = async () => {
  const res = await fetch(
    `${BASE}/api/top-traders?address=${token.address}&chain=solana&limit=50`,
    { headers: { "x-claim-token": CLAIM } }
  );
  const body = await res.json();
  return { status: res.status, reason: body.reason, traders: body.traders?.length ?? 0 };
};

try {
  await sql`delete from scan_credits where claim_token = ${CLAIM}`;
  await sql`insert into scan_credits (payment_id, method, tier, claim_token)
            values (${PAYMENT_ID}, 'test', 50, ${CLAIM})`;

  console.log("\nA. reserve -> deliver");
  const a = await scan();
  check("status", a.status, 200);
  check("traders delivered", a.traders > 0, true);
  check("reserved_at cleared on delivery", (await row()).reserved_at, null);

  console.log("\nB. retry while the scan is genuinely in flight");
  await sql`update scan_credits set reserved_at = now() where claim_token = ${CLAIM}`;
  const b = await scan();
  check("status", b.status, 402);
  check("reason", b.reason, "credit_pending");

  console.log("\nC. retry after the scan died (reservation older than the takeover window)");
  await sql`update scan_credits set reserved_at = now() - interval '3 minutes' where claim_token = ${CLAIM}`;
  const c = await scan();
  check("status", c.status, 200);
  check("traders delivered", c.traders > 0, true);

  console.log("\nD. cron sweeper releases an abandoned reservation");
  await sql`update scan_credits set reserved_at = now() - interval '15 minutes' where claim_token = ${CLAIM}`;
  const sweep = await fetch(`${BASE}/api/cron/release-stale-credits`, {
    headers: { authorization: `Bearer ${process.env.CRON_SECRET ?? ""}` },
  });
  check("sweeper status", sweep.status, 200);
  const after = await row();
  check("consumed_at given back", after.consumed_at, null);
  check("reserved_at cleared", after.reserved_at, null);

  console.log("\nE. a delivered credit stays spent");
  await sql`update scan_credits set consumed_at = now(), consumed_chain = 'solana',
            consumed_token_address = ${token.address}, reserved_at = null
            where claim_token = ${CLAIM}`;
  const e = await scan();
  check("status", e.status, 402);
  check("reason", e.reason, "credit_used");
} finally {
  await sql`delete from scan_credits where claim_token = ${CLAIM}`;
  await sql.end();
}

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
