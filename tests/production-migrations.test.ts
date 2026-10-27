import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { test } from "vitest";

test("production deployment migrates before deploying the existing production build", () => {
  const { scripts } = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  );
  assert.match(
    scripts.deploy,
    /^pnpm\s+(?:run\s+)?db:migrate:production\s+&&\s+wrangler\s+deploy\b/,
  );
  assert.match(
    scripts.deploy,
    /--config\s+["']?(?:\.\/)?dist\/server\/wrangler\.json\b/,
  );
  assert.doesNotMatch(scripts.deploy, /\bbuild\b|preview|seed|--env\b/);
  assert.match(scripts.build, /\bastro\s+build\b/);
  assert.doesNotMatch(scripts.build, /db:migrate|--remote\b|\bdeploy\b/);
});

test("production migration guard pins the isolated account/database and rejects deployable configs", () => {
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
        import assert from 'node:assert/strict';
        import { unstable_readConfig as readConfig } from 'wrangler';
        import { checkProductionMigrations as check } from './scripts/check-production-migrations.mjs';
        const config = readConfig({ config: 'wrangler.jsonc' });
        const migrations = readConfig({ config: 'wrangler.production-migrations.jsonc' });
        check(config, migrations);
        for (const change of [
          { account_id: 'wrong-account' },
          { d1_databases: config.previews.d1_databases },
          { d1_databases: config.d1_databases },
          { d1_databases: [] },
          { name: config.name },
          { main: './src/worker.ts' },
          { assets: { directory: './dist' } },
          { build: { command: 'pnpm build' } },
        ]) assert.throws(() => check(config, { ...migrations, ...change }));
        const [target] = migrations.d1_databases;
        for (const change of [{ migrations_dir: 'other' }, { preview_database_id: target.database_id }])
          assert.throws(() => check(config, { ...migrations, d1_databases: [{ ...target, ...change }] }));
        assert.throws(() => check({ ...config, previews: { d1_databases: [target] } }, migrations));
      `,
    ],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
});

test("production migration command validates first, explicitly targets remote D1, and never deploys", () => {
  const { scripts } = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  );
  assert.equal(
    scripts["db:migrate:production"],
    "pnpm db:check && node scripts/migrate-production.mjs",
  );
  const runner = readFileSync(
    new URL("../scripts/migrate-production.mjs", import.meta.url),
    "utf8",
  );
  assert.match(runner, /"scripts\/check-production-migrations\.mjs"/);
  assert.match(runner, /"PRODUCTION_DB"/);
  assert.match(runner, /"wrangler\.production-migrations\.jsonc"/);
  assert.match(runner, /"--remote"/);
  assert.doesNotMatch(runner, /"deploy"|"--env"|"--local"|"--preview"/);
  for (const script of [
    "scripts/check-production-migrations.mjs",
    "scripts/migrate-production.mjs",
  ]) {
    const result = spawnSync(process.execPath, [script, "--env", "preview"], {
      encoding: "utf8",
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /No environment or target overrides allowed/);
  }
  for (const [override, message] of [
    [{ CLOUDFLARE_ENV: "preview" }, /Unset CLOUDFLARE_ENV/],
    [
      { CLOUDFLARE_ACCOUNT_ID: "wrong-account" },
      /must match the production account/,
    ],
  ] as const) {
    const env = {
      ...process.env,
      CLOUDFLARE_ENV: "",
      CLOUDFLARE_ACCOUNT_ID: "",
    };
    Object.assign(env, override);
    const result = spawnSync(
      process.execPath,
      ["scripts/migrate-production.mjs"],
      {
        encoding: "utf8",
        env,
      },
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, message);
  }
});
