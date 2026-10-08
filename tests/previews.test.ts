import assert from "node:assert/strict";
import { test } from "vitest";
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
  const deploy = scripts["deploy:preview"];
  assert.match(deploy, /\bpnpm\s+(?:run\s+)?build:preview\b/);
  assert.match(deploy, /\bpnpm\s+(?:run\s+)?db:migrate:preview\b/);
  assert.match(deploy, /\bwrangler\s+preview\b/);
  assert.match(
    deploy,
    /--config\s+["']?(?:\.\/)?dist-preview\/server\/wrangler\.json\b/,
  );
  assert.ok(
    deploy.indexOf("build:preview") < deploy.indexOf("db:migrate:preview"),
  );
  assert.ok(deploy.indexOf("db:migrate:preview") < deploy.indexOf("wrangler"));
  assert.doesNotMatch(deploy, /seed|versions|--env\b|\bwrangler\s+deploy\b/);

  const migrations = scripts["db:migrate:preview"];
  assert.match(
    migrations,
    /\bnode\s+(?:\.\/)?scripts\/check-preview-migrations\.mjs\b/,
  );
  assert.match(
    migrations,
    /\bwrangler\s+d1\s+migrations\s+apply\s+PREVIEW_DB\b/,
  );
  assert.match(
    migrations,
    /--config\s+["']?(?:\.\/)?wrangler\.preview-migrations\.jsonc\b/,
  );
  assert.match(migrations, /--remote\b/);
  assert.ok(
    migrations.indexOf("check-preview-migrations.mjs") <
      migrations.indexOf("wrangler d1"),
  );
  assert.doesNotMatch(migrations, /--env\b|--local\b/);

  const build = scripts["build:preview"];
  assert.match(build, /\bastro\s+build\b/);
  assert.match(build, /--mode(?:\s+|=)preview\b/);
  assert.match(build, /--outDir(?:\s+|=)["']?(?:\.\/)?dist-preview\b/);
});
