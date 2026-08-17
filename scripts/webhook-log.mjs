import postgres from "postgres";

const sql = postgres(process.env.POSTGRES_URL_NON_POOLING || process.env.POSTGRES_URL, {
  prepare: false,
  max: 1,
});

const rows = await sql`
  select id, outcome, auth_header, header_names, query, body, created_at
  from webhook_log order by created_at desc limit 10`;

console.log(`entries: ${rows.length}\n`);
for (const r of rows) {
  console.log("─".repeat(70));
  console.log(`#${r.id}  ${r.outcome}  ${r.created_at.toISOString()}`);
  console.log(`auth   : ${r.auth_header}`);
  console.log(`query  : ${r.query || "(none)"}`);
  console.log(`headers: ${r.header_names}`);
  console.log(`body   : ${r.body}`);
}

await sql.end();
