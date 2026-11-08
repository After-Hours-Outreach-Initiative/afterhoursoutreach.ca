import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "vitest";

function loadViteConfig(nodeEnv?: string) {
  const environment = { ...process.env };
  if (nodeEnv) environment.NODE_ENV = nodeEnv;
  else delete environment.NODE_ENV;

  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `const { default: config } = await import(${JSON.stringify(new URL("../astro.config.mjs", import.meta.url).href)});
       console.log(JSON.stringify({ cacheDir: config.vite.cacheDir, optimizeDeps: config.vite.optimizeDeps }));`,
    ],
    { env: environment, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test("Astro check, sync, and builds cannot overwrite the dev dependency cache", () => {
  const development = loadViteConfig("development");
  const production = loadViteConfig("production");

  assert.equal(
    development.cacheDir,
    fileURLToPath(
      new URL("../node_modules/.vite/development/", import.meta.url),
    ),
  );
  assert.equal(
    production.cacheDir,
    fileURLToPath(
      new URL("../node_modules/.vite/production/", import.meta.url),
    ),
  );
  assert.notEqual(production.cacheDir, development.cacheDir);
  assert.equal(loadViteConfig().cacheDir, development.cacheDir);

  // Keep browser pre-bundling: the missing file was in the server cache, not an
  // incompatible Better Auth client dependency.
  assert.ok(development.optimizeDeps.include.includes("better-auth/client"));
  assert.ok(
    development.optimizeDeps.include.includes("better-auth/client/plugins"),
  );
});
