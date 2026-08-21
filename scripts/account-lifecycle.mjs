/**
 * Exercises wallet sign-in, the retroactive purchase backfill, account-balance
 * scanning and the 7-day result store, against a running server and the real
 * database. Run it before trusting any change to src/lib/auth/*,
 * src/lib/db/users.ts, src/lib/db/credits.ts or src/lib/access.ts.
 *
 * It invents a throwaway Ed25519 keypair — a real Solana-shaped wallet nobody
 * holds funds in — and creates/deletes only rows it owns (payment_id prefixed
 * TESTONLY-). It never touches a real purchase. It DOES run genuine scans, so
 * it spends upstream API credits.
 *
 *   npm run dev
 *   env -u DATABASE_URL node --env-file=.env.local scripts/account-lifecycle.mjs
 *
 * Requires PAYMENTS_ENABLED=true (otherwise every scan is free and no credit is
 * ever reserved) and CRON_SECRET for the purge step.
 *
 * NOTE: buildSignInMessage is duplicated below. scripts/ cannot import from
 * src/lib (the `server-only` boundary), same as scripts/enrich-wallets.mjs and
 * the quality constants. If src/lib/auth/message.ts changes, change this too —
 * step A fails loudly if they drift, which is the point.
 */
import { generateKeyPairSync, sign as edSign } from "node:crypto";
import bs58 from "bs58";
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

let failures = 0;
const check = (label, actual, expected) => {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(
    `  ${ok ? "PASS" : "FAIL"}  ${label}: ${actual}${ok ? "" : ` (expected ${expected})`}`
  );
};

/* -- the throwaway wallet ------------------------------------------------- */

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const rawPublicKey = publicKey.export({ format: "der", type: "spki" }).subarray(12);
const WALLET = bs58.encode(rawPublicKey);
const signMessage = (message) => bs58.encode(edSign(null, Buffer.from(message, "utf8"), privateKey));

/** Mirror of src/lib/auth/message.ts. Keep in sync. */
const buildSignInMessage = (wallet, nonce) =>
  [
    "alphawallets.fun",
    "Sign in to Alpha Wallet Finder",
    "",
    "This signature is free. It approves no transaction and moves no funds.",
    "It proves you own this wallet, so your purchases can be restored to it.",
    "",
    `Wallet: ${wallet}`,
    `Nonce: ${nonce}`,
  ].join("\n");

/* -- helpers -------------------------------------------------------------- */

let cookie = null;

function captureCookie(res) {
  const header = res.headers.get("set-cookie");
  if (!header) return;
  const match = /aw_user=([^;]*)/.exec(header);
  if (match) cookie = match[1] ? `aw_user=${match[1]}` : null;
}

const authed = (extra = {}) => ({ ...extra, ...(cookie ? { cookie } : {}) });

/** The receipt is written under `waitUntil`, i.e. after the response is sent. */
const settle = (ms = 2000) => new Promise((r) => setTimeout(r, ms));

const post = async (path, body, headers = {}) => {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  captureCookie(res);
  return { status: res.status, body: await res.json().catch(() => ({})) };
};

const CLAIM = `account-test-${Date.now()}`;
const PAYMENT_PREFIX = `TESTONLY-${CLAIM}`;

const [token] = await sql`
  select address from tokens where chain = 'solana' order by last_scanned_at desc nulls last limit 1`;
if (!token) {
  console.error("No solana token in the database to scan. Run a scan first.");
  process.exit(1);
}

const scan = async (headers = {}, limit = 50) => {
  const res = await fetch(
    `${BASE}/api/top-traders?address=${token.address}&chain=solana&limit=${limit}`,
    { headers }
  );
  const body = await res.json().catch(() => ({}));
  return {
    status: res.status,
    reason: body.reason,
    creditSource: body.creditSource,
    traders: body.traders?.length ?? 0,
  };
};

const cleanup = async () => {
  await sql`delete from scan_results where credit_id in (
              select id from scan_credits where payment_id like ${PAYMENT_PREFIX + "%"})`;
  await sql`delete from scan_results where user_id in (
              select id from users where wallet = ${WALLET})`;
  await sql`delete from scan_credits where payment_id like ${PAYMENT_PREFIX + "%"}`;
  await sql`delete from auth_nonces where wallet = ${WALLET}`;
  await sql`delete from users where wallet = ${WALLET}`;
};

/* -- the run -------------------------------------------------------------- */

try {
  await cleanup();

  console.log(`\nthrowaway wallet: ${WALLET}`);

  console.log("\nA. a purchase made BEFORE this wallet ever signed in");
  await sql`insert into scan_credits (payment_id, method, tier, claim_token, payer_wallet)
            values (${`${PAYMENT_PREFIX}-legacy`}, 'test', 50, ${`${CLAIM}-legacy`}, ${WALLET})`;
  check("credit starts unattached", (await creditUserId(`${CLAIM}-legacy`)) === null, true);

  console.log("\nB. sign in: nonce -> signMessage -> verify");
  const nonceRes = await post("/api/auth/nonce", { wallet: WALLET });
  check("nonce status", nonceRes.status, 200);
  check(
    "server message matches the one we sign",
    nonceRes.body.message,
    buildSignInMessage(WALLET, nonceRes.body.nonce)
  );
  const nonce = nonceRes.body.nonce;
  const signature = signMessage(buildSignInMessage(WALLET, nonce));

  const verifyRes = await post("/api/auth/verify", { wallet: WALLET, nonce, signature });
  check("verify status", verifyRes.status, 200);
  check("session cookie issued", cookie !== null, true);

  console.log("\nC. the past purchase is now on the account");
  check("credit attached retroactively", (await creditUserId(`${CLAIM}-legacy`)) !== null, true);

  console.log("\nD. replaying the same nonce is refused");
  const replay = await post("/api/auth/verify", { wallet: WALLET, nonce, signature });
  check("replay status", replay.status, 401);

  console.log("\nE. a signature from a DIFFERENT wallet is refused");
  const other = generateKeyPairSync("ed25519");
  const otherNonce = (await post("/api/auth/nonce", { wallet: WALLET })).body.nonce;
  const forged = bs58.encode(
    edSign(null, Buffer.from(buildSignInMessage(WALLET, otherNonce), "utf8"), other.privateKey)
  );
  check(
    "forged signature status",
    (await post("/api/auth/verify", { wallet: WALLET, nonce: otherNonce, signature: forged }))
      .status,
    401
  );

  console.log("\nF. /api/auth/me reports the wallet and balance");
  const me = await fetch(`${BASE}/api/auth/me`, { headers: authed() });
  const meBody = await me.json();
  check("me status", me.status, 200);
  check("wallet", meBody.user?.wallet, WALLET);
  check("balance total", meBody.balance?.total, 1);

  console.log("\nG. a tampered cookie is not a session");
  const tampered = await fetch(`${BASE}/api/auth/me`, {
    headers: { cookie: cookie.slice(0, -3) + "AAA" },
  });
  check("tampered user", (await tampered.json()).user, null);

  console.log("\nH. scanning spends the account credit, not a claim token");
  const h = await scan(authed());
  check("status", h.status, 200);
  check("traders delivered", h.traders > 0, true);
  check("credit source", h.creditSource, "account");
  check("balance now empty", await balanceTotal(), 0);

  console.log("\nI. the delivered payload was stored as a 7-day receipt");
  await settle();
  const stored = await sql`
    select id, trader_count, expires_at from scan_results
    where user_id = (select id from users where wallet = ${WALLET})
    order by created_at desc limit 1`;
  check("result row written", stored.length, 1);
  if (stored.length) {
    check("trader count matches", Number(stored[0].trader_count), h.traders);
    const days = (stored[0].expires_at.getTime() - Date.now()) / 86_400_000;
    check("expires in ~7 days", days > 6.9 && days < 7.1, true);

    console.log("\nJ. re-download reads storage, hits no upstream API");
    const re = await fetch(`${BASE}/api/scan-results/${stored[0].id}`, { headers: authed() });
    const reBody = await re.json();
    check("status", re.status, 200);
    check("same wallet count", reBody.traders?.length, h.traders);
    check("flagged as stored", reBody.fromStoredResult, true);
    check("scan session re-issued", typeof reBody.scanSession === "string", true);

    console.log("\nK. someone else's result id is a 404, not a 403");
    const anon = await fetch(`${BASE}/api/scan-results/${stored[0].id}`);
    check("no session", anon.status, 401);
  }

  console.log("\nL. two concurrent scans against ONE account credit");
  await sql`insert into scan_credits (payment_id, method, tier, claim_token, payer_wallet, user_id)
            values (${`${PAYMENT_PREFIX}-race`}, 'test', 50, ${`${CLAIM}-race`}, ${WALLET},
                    (select id from users where wallet = ${WALLET}))`;
  const [r1, r2] = await Promise.all([scan(authed()), scan(authed())]);
  const wins = [r1, r2].filter((r) => r.status === 200).length;
  check("exactly one succeeded", wins, 1);
  check("the other was refused", [r1, r2].some((r) => r.status === 402), true);

  console.log("\nM. an unattached claim token still redeems for a signed-in user");
  await sql`insert into scan_credits (payment_id, method, tier, claim_token)
            values (${`${PAYMENT_PREFIX}-anon`}, 'test', 50, ${`${CLAIM}-anon`})`;
  const m = await scan(authed({ "x-claim-token": `${CLAIM}-anon` }));
  check("status", m.status, 200);
  check("credit source", m.creditSource, "claim_token");

  console.log("\nN. absorbing a browser-held claim token onto the account");
  await sql`insert into scan_credits (payment_id, method, tier, claim_token)
            values (${`${PAYMENT_PREFIX}-absorb`}, 'test', 100, ${`${CLAIM}-absorb`})`;
  const absorb = await post("/api/auth/absorb", { claimToken: `${CLAIM}-absorb` }, authed());
  check("absorb status", absorb.status, 200);
  check("outcome", absorb.body.outcome, "absorbed");
  check("balance picked it up", await balanceTotal(), 1);

  console.log("\nO. the purge deletes an expired result and keeps a pinned one");
  const rows = await sql`
    select id from scan_results
    where user_id = (select id from users where wallet = ${WALLET}) order by id`;
  if (rows.length >= 2) {
    await sql`update scan_results set expires_at = now() - interval '1 day', pinned = false
              where id = ${rows[0].id}`;
    await sql`update scan_results set expires_at = now() - interval '1 day', pinned = true
              where id = ${rows[1].id}`;
    const purge = await fetch(`${BASE}/api/cron/purge-scan-results`, {
      headers: { authorization: `Bearer ${process.env.CRON_SECRET ?? ""}` },
    });
    check("purge status", purge.status, 200);
    check("expired row gone", await resultExists(rows[0].id), false);
    check("pinned row kept", await resultExists(rows[1].id), true);
  } else {
    console.log("  SKIP  needs two stored results; only found " + rows.length);
  }

  console.log("\nP. unauthenticated purge is refused");
  check("no bearer", (await fetch(`${BASE}/api/cron/purge-scan-results`)).status, 401);

  console.log("\nQ. logout ends the session");
  const out = await post("/api/auth/logout", {}, authed());
  check("logout status", out.status, 200);
  const afterOut = await fetch(`${BASE}/api/auth/me`, { headers: { cookie: "aw_user=" } });
  check("me is signed out", (await afterOut.json()).user, null);
} finally {
  await cleanup();
  await sql.end();
}

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);

/* -- small queries -------------------------------------------------------- */

async function creditUserId(claimToken) {
  const [row] = await sql`select user_id from scan_credits where claim_token = ${claimToken}`;
  return row?.user_id ?? null;
}

async function balanceTotal() {
  const res = await fetch(`${BASE}/api/auth/me`, { headers: authed() });
  return (await res.json()).balance?.total ?? 0;
}

async function resultExists(id) {
  const rows = await sql`select 1 from scan_results where id = ${id}`;
  return rows.length > 0;
}
