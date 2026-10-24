import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

// Reject forwarded package-script arguments before invoking any remote command.
assert.equal(
  process.argv.length,
  2,
  "No environment or target overrides allowed.",
);
for (const [command, args] of [
  [process.execPath, ["scripts/check-production-migrations.mjs"]],
  [
    "pnpm",
    [
      "exec",
      "wrangler",
      "d1",
      "migrations",
      "apply",
      "PRODUCTION_DB",
      "--config",
      "wrangler.production-migrations.jsonc",
      "--remote",
    ],
  ],
]) {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
