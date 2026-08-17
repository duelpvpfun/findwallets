import { createHash } from "node:crypto";

const fp = (s) => createHash("sha256").update(s).digest("hex").slice(0, 8);

const arg = process.argv[2];
if (arg) {
  const s = arg.trim();
  console.log(`len=${s.length} fingerprint=${fp(s)}`);
  if (s.length !== 128) console.log("warning: expected 128 characters — the paste may be truncated");
} else {
  const list = (process.env.HELIO_WEBHOOK_SECRET ?? "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
  if (list.length === 0) console.log("HELIO_WEBHOOK_SECRET is empty");
  list.forEach((s, i) => console.log(`#${i + 1} len=${s.length} fingerprint=${fp(s)}`));
}
