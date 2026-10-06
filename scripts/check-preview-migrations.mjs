import assert from "node:assert/strict";
import { unstable_readConfig as readConfig } from "wrangler";

const config = readConfig({ config: "wrangler.jsonc" });
const migrations = readConfig({ config: "wrangler.preview-migrations.jsonc" });
const preview = config.previews?.d1_databases?.find(
  (db) => db.binding === "DB",
);
const target = migrations.d1_databases.find(
  (db) => db.binding === "PREVIEW_DB",
);
assert.ok(
  preview && target,
  "Preview database and migration target are required.",
);
for (const field of ["database_name", "database_id", "migrations_dir"])
  assert.equal(
    target[field],
    preview[field],
    `Preview migration ${field} differs.`,
  );
assert.ok(
  target.database_id &&
    target.database_id !== "00000000-0000-0000-0000-000000000000" &&
    !config.d1_databases.some((db) => db.database_id === target.database_id),
  "Preview migrations must target a real non-production database.",
);
assert.equal(migrations.account_id, config.account_id);
