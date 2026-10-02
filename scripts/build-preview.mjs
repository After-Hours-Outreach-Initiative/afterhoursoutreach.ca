import { spawnSync } from "node:child_process";
import { readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { unstable_readConfig as readConfig } from "wrangler";

const root = fileURLToPath(new URL("../", import.meta.url));
function run(args) {
  const result = spawnSync("pnpm", args, {
    cwd: root,
    stdio: "inherit",
    // Do not let an inherited Wrangler environment retarget the parent Worker.
    env: { ...process.env, CLOUDFLARE_ENV: "" },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run(["exec", "wrangler", "types", "--strict-vars", "false"]);
run([
  "exec",
  "astro",
  "build",
  "--mode",
  "preview",
  "--outDir",
  "./dist-preview",
]);

// The adapter must retain the preview block, not flatten it into production.
const source = readConfig({
  config: fileURLToPath(new URL("../wrangler.jsonc", import.meta.url)),
});
const built = JSON.parse(
  await readFile(
    new URL("../dist-preview/server/wrangler.json", import.meta.url),
    "utf8",
  ),
);
assert.equal(built.name, source.name);
assert.equal(built.account_id, source.account_id);
assert.equal(built.previews?.vars?.APP_ENV, "preview");
assert.deepEqual(built.previews?.vars, source.previews?.vars);
assert.equal(built.previews?.d1_databases?.length, 1);
assert.equal(
  built.previews.d1_databases[0].database_id,
  source.previews.d1_databases[0].database_id,
);
assert.notEqual(
  built.previews.d1_databases[0].database_id,
  built.d1_databases[0].database_id,
);
assert.ok(
  !built.routes?.length && !built.route,
  "Preview build must not configure production routes.",
);

// Static responses bypass Astro middleware; give them the same preview headers.
const assets = new URL("../dist-preview/client/", import.meta.url);
// Astro emits scripts from imported components even when their render branch
// is disabled. Exclude unused legacy patrol scripts and any dev-only helpers.
const chunksDirectory = new URL("_astro/", assets);
const chunks = new Map(
  await Promise.all(
    (await readdir(chunksDirectory))
      .filter((name) => name.endsWith(".js"))
      .map(async (name) => [
        name,
        await readFile(new URL(name, chunksDirectory), "utf8"),
      ]),
  ),
);
const demoChunks = new Set(
  [...chunks.keys()].filter((name) =>
    /^(?:PatrolList\.astro_|patrol-store\.|local-email-dialog\.|account-switcher\.)/.test(
      name,
    ),
  ),
);
let changed;
do {
  changed = false;
  for (const [name, source] of chunks) {
    if (
      !demoChunks.has(name) &&
      [...demoChunks].some((demo) => source.includes(demo))
    ) {
      demoChunks.add(name);
      changed = true;
    }
  }
} while (changed);
for (const path of (await readdir(assets, { recursive: true })).filter((path) =>
  path.endsWith(".html"),
)) {
  const content = await readFile(new URL(path, assets), "utf8");
  if ([...demoChunks].some((name) => content.includes(name)))
    throw new Error(
      `Refusing to package a page that loads a demo script: ${path}`,
    );
}
await Promise.all(
  [...demoChunks].map((name) => unlink(new URL(name, chunksDirectory))),
);

let existingHeaders = "";
try {
  existingHeaders = await readFile(new URL("_headers", assets), "utf8");
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
await writeFile(
  new URL("_headers", assets),
  `${existingHeaders}\n/*\n  X-Robots-Tag: noindex, nofollow, noarchive\n  Cache-Control: no-store\n`,
);
await writeFile(new URL("robots.txt", assets), "User-agent: *\nDisallow: /\n");

// Fail closed if the preview warning is missing or a local mockup leaks through.
// /volunteer is request-rendered; Worker tests check its warning and isolation.
// The static homepage loads public event summaries from D1 through /api/events.
const staticPage = await readFile(new URL("index.html", assets), "utf8");
if (
  staticPage.includes("data-account-switcher") ||
  staticPage.includes("data-event-teaser") ||
  staticPage.includes("data-patrol-list") ||
  !staticPage.includes("Preview · public test site")
) {
  throw new Error("Refusing to package mock event listings on previews.");
}
