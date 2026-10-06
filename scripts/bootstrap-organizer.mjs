import { spawnSync } from "node:child_process";
import { z } from "zod";

const args = process.argv.slice(2);
const email = args[args.indexOf("--email") + 1];
const local = args.includes("--local");
if (
  !args.includes("--email") ||
  !z.email().safeParse(email).success ||
  !local ||
  args.length !== 3
) {
  console.error(
    "Usage: pnpm organizer:bootstrap --local --email verified@example.org",
  );
  process.exit(1);
}
// Only an explicit local target. No production mode.
const escapedEmail = email.trim().toLowerCase().replaceAll("'", "''");
const sql = `INSERT INTO organizer_bootstrap(id,user_id,created_at)
  VALUES(1,(SELECT id FROM user WHERE lower(email)='${escapedEmail}'),${Date.now()}) RETURNING id`;
const result = spawnSync(
  "pnpm",
  [
    "exec",
    "wrangler",
    "d1",
    "execute",
    "DB",
    "--local",
    "--command",
    sql,
    "--json",
  ],
  { encoding: "utf8", env: { ...process.env, CLOUDFLARE_ENV: "" } },
);
// Suppress CLI output, including submitted SQL and the recipient's email.
if (result.error || result.status !== 0) {
  console.error(
    "Bootstrap failed. Apply migrations and verify that this account has a verified email and active registration, and that no organizer already exists.",
  );
  process.exit(1);
}
console.log("First organizer created and audited. Sign in again to continue.");
