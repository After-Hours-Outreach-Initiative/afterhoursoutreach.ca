import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rmdir, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { previewEventFixtures } from "./preview-event-fixtures";

const root = fileURLToPath(new URL("../", import.meta.url));
if (process.argv.length !== 2)
  throw new Error(
    "Usage: pnpm db:seed:preview (shared preview D1 only; no arguments)",
  );
const env = { ...process.env, CLOUDFLARE_ENV: "" };
// The existing guard checks the account, Preview binding, and non-production ID.
const guard = spawnSync(
  process.execPath,
  ["scripts/check-preview-migrations.mjs"],
  {
    cwd: root,
    stdio: "inherit",
    env,
  },
);
if (guard.error || guard.status !== 0)
  throw new Error(
    "Preview seeding refused: check the preview database configuration.",
  );

const temporaryRoot = join(tmpdir(), "opencode");
await mkdir(temporaryRoot, { recursive: true });
const directory = await mkdtemp(join(temporaryRoot, "preview-events-"));
const file = join(directory, "fixtures.sql");
try {
  await writeFile(file, previewEventFixtures().join(";\n") + ";\n", {
    mode: 0o600,
  });
  const seeded = spawnSync(
    "pnpm",
    [
      "exec",
      "wrangler",
      "d1",
      "execute",
      "PREVIEW_DB",
      "--config",
      "wrangler.preview-migrations.jsonc",
      "--remote",
      "--file",
      file,
      "--yes",
    ],
    { cwd: root, stdio: "inherit", env },
  );
  if (seeded.error || seeded.status !== 0)
    throw new Error(
      "Preview seeding failed. Check authentication and preview migrations.",
    );
  console.log(
    "Preview sample volunteers, events, and orientation rosters are ready. Existing records and edits are preserved; no emails or organizer privileges are created.",
  );
} finally {
  await unlink(file);
  await rmdir(directory);
}
