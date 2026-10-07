import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { unstable_readConfig as readConfig } from "wrangler";

const configPath = new URL("../wrangler.jsonc", import.meta.url).pathname;

test("branch previews target the main Worker with non-production bindings, not version URLs", () => {
  const config = readConfig({ config: configPath });
  assert.equal(config.name, "afterhoursoutreach-ca");
  assert.deepEqual(config.routes ?? [], []);
  assert.equal(config.account_id, "76222ab803494dc84947546283e1a63a");
  assert.equal(config.preview_urls, true);
  const previews = config.previews!;
  assert.equal(previews.d1_databases!.length, 1);
  assert.equal(previews.d1_databases![0].binding, "DB");
  assert.equal(
    previews.d1_databases![0].database_name,
    "afterhoursoutreach-staging",
  );
  assert.equal(
    previews.d1_databases![0].database_id,
    "4412ad44-0ca9-4ebd-8f08-78bb1092bc0d",
  );
  assert.equal(previews.vars?.APP_ENV, "preview");
  assert.equal(previews.vars?.AUTH_BASE_URL, "");
  assert.equal(previews.vars?.PREVIEW_HOST_SUFFIX, undefined);
  assert.deepEqual(config.secrets?.required, [
    "BETTER_AUTH_SECRET",
    "RESEND_API_KEY",
  ]);
});

test("the default environment does not use preview resources", () => {
  const config = readConfig({ config: configPath });
  assert.equal(config.name, "afterhoursoutreach-ca");
  assert.equal(config.vars.AUTH_BASE_URL, "https://afterhoursoutreach.ca");
  assert.equal(config.d1_databases[0].database_name, "afterhoursoutreach");
  assert.equal(config.vars.APP_ENV, "production");
  assert.equal(config.d1_databases[0].remote, false);
  assert.notEqual(
    config.d1_databases[0].database_id,
    "4412ad44-0ca9-4ebd-8f08-78bb1092bc0d",
  );
});

test("Astro disables all remote bindings in development", () => {
  const config = readFileSync(
    new URL("../astro.config.mjs", import.meta.url),
    "utf8",
  );
  assert.match(config, /remoteBindings: false/);
});

test("organizer bootstrap refuses implicit targets and production mode", () => {
  for (const args of [
    [],
    ["--production", "--email", "verified@example.org"],
    ["--local", "--preview", "--email", "verified@example.org"],
  ]) {
    const result = spawnSync(
      process.execPath,
      ["scripts/bootstrap-organizer.mjs", ...args],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Usage:/);
    assert.doesNotMatch(result.stdout, /Executing|verified@example.org/);
  }
});

test("preview migrations match the shared binding and cannot target production", () => {
  const result = spawnSync(
    process.execPath,
    ["scripts/check-preview-migrations.mjs"],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
});

test("deployment scripts explicitly select Worker Previews and their migration target", () => {
  const { scripts } = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  );
  assert.equal(
    scripts["deploy:preview"],
    "pnpm build:preview && pnpm db:migrate:preview && wrangler preview --config dist-preview/server/wrangler.json",
  );
  assert.equal(
    scripts["db:migrate:preview"],
    "node scripts/check-preview-migrations.mjs && wrangler d1 migrations apply PREVIEW_DB --config wrangler.preview-migrations.jsonc --remote",
  );
  assert.equal(
    scripts["db:seed:preview"],
    "tsx scripts/seed-preview-events.ts",
  );
  assert.doesNotMatch(scripts["deploy:preview"], /seed/);
  assert.equal(
    scripts.deploy,
    "pnpm build && wrangler deploy --config dist/server/wrangler.json",
  );
  assert.equal(
    scripts["build:preview"],
    "wrangler types --strict-vars false && astro build --mode preview --outDir ./dist-preview",
  );
  assert.equal(
    scripts["test:accounts"],
    "pnpm build && tsx --test tests/worker/*.test.ts",
  );
  assert.equal(scripts.preview, "astro preview");
  assert.equal(scripts["build:staging"], undefined);
  assert.equal(scripts["deploy:staging"], undefined);
  assert.doesNotMatch(scripts["deploy:preview"], /versions|--env/);
});
