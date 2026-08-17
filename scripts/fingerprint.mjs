import { createHash } from "node:crypto";
const fp = (s) => createHash("sha256").update(s).digest("hex").slice(0, 8);
const arg = process.argv[2];
if (arg) {
  const s = arg.trim();
  console.log(`pasted secret: len=${s.length} fingerprint=${fp(s)}`);
  console.log(fp(s) === "7f20e86a" ? "MATCH - this is the token Helio is sending" : "NO MATCH - wrong webhook's secret");
} else {
  for (const s of (process.env.HELIO_WEBHOOK_SECRET ?? "").split(",").map((x) => x.trim()).filter(Boolean)) {
    console.log(`len=${s.length} fingerprint=${fp(s)}`);
  }
}
