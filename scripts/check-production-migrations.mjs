import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { unstable_readConfig as readConfig } from "wrangler";

export function checkProductionMigrations(config, migrations) {
  const account = "76222ab803494dc84947546283e1a63a";
  const id = "ca19de7e-de80-41a5-827a-7130c34ea3da";
  assert.equal(config.name, "afterhoursoutreach-ca");
  assert.equal(config.account_id, account);
  assert.equal(migrations.account_id, account);
  assert.equal(migrations.d1_databases.length, 1);
  const [target] = migrations.d1_databases;
  assert.equal(target.binding, "PRODUCTION_DB");
  assert.equal(target.database_name, "afterhoursoutreach-production");
  assert.equal(target.database_id, id);
  assert.equal(target.migrations_dir, "drizzle");
  assert.ok(!target.preview_database_id);
  assert.ok(
    !config.previews?.d1_databases?.some((db) => db.database_id === id),
    "Production migrations must never target a Preview database.",
  );
  // No deployable entrypoint, asset directory, or build command in this config.
  for (const field of ["name", "main", "assets", "site"])
    assert.ok(
      !migrations[field],
      `Migration-only config must not set ${field}.`,
    );
  assert.ok(!migrations.build?.command);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  assert.equal(
    process.argv.length,
    2,
    "No environment or target overrides allowed.",
  );
  assert.ok(
    !process.env.CLOUDFLARE_ENV,
    "Unset CLOUDFLARE_ENV for migrations.",
  );
  assert.ok(
    !process.env.CLOUDFLARE_ACCOUNT_ID ||
      process.env.CLOUDFLARE_ACCOUNT_ID === "76222ab803494dc84947546283e1a63a",
    "CLOUDFLARE_ACCOUNT_ID must match the production account.",
  );
  checkProductionMigrations(
    readConfig({ config: "wrangler.jsonc" }),
    readConfig({ config: "wrangler.production-migrations.jsonc" }),
  );
}
