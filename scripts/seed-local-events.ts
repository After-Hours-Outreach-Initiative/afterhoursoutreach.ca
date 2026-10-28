import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rmdir, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { request } from "@playwright/test";
import { unstable_readConfig as readConfig } from "wrangler";
import { localAccountFixtures } from "./local-account-fixtures";
import { localEventFixtures } from "./local-event-fixtures";

const root = fileURLToPath(new URL("../", import.meta.url));
// The browser-test harness selects its broader fixtures in a disposable copy.
// The normal command always seeds the small manual View as dataset.
const testFixtures =
  process.argv.length === 3 && process.argv[2] === "--test-fixtures";
if (process.argv.length !== 2 && !testFixtures)
  throw new Error("Usage: pnpm db:seed:local (local only)");
const config: {
  vars?: Record<string, unknown>;
  d1_databases?: { binding: string; remote?: boolean }[];
} = readConfig({
  config: fileURLToPath(new URL("../wrangler.jsonc", import.meta.url)),
});
const origin = new URL(process.env.LOCAL_BASE_URL ?? "http://localhost:4321");
if (
  !["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname) ||
  !config.d1_databases?.some((db) => db.binding === "DB" && db.remote === false)
)
  throw new Error(
    "Seeding requires a loopback dev server and local D1 binding.",
  );

const client = await request.newContext({
  baseURL: origin.origin,
  extraHTTPHeaders: { origin: origin.origin },
});
try {
  // Confirm the server is actually in development before making any writes.
  const listing = await client.get("/api/v1/auth/dev/users");
  if (!listing.ok())
    throw new Error(
      "Start the local dev server and apply local migrations before seeding.",
    );
  const temporaryRoot = join(tmpdir(), "opencode");
  await mkdir(temporaryRoot, { recursive: true });
  const directory = await mkdtemp(join(temporaryRoot, "local-events-"));
  const file = join(directory, "fixtures.sql");
  try {
    const fixtures = testFixtures
      ? localEventFixtures()
      : localAccountFixtures();
    await writeFile(file, fixtures.join(";\n") + ";\n", {
      mode: 0o600,
    });
    const seeded = spawnSync(
      "pnpm",
      [
        "exec",
        "wrangler",
        "d1",
        "execute",
        "DB",
        "--config",
        "wrangler.jsonc",
        "--local",
        "--file",
        file,
      ],
      {
        cwd: root,
        encoding: "utf8",
        env: { ...process.env, CLOUDFLARE_ENV: "" },
      },
    );
    if (seeded.error || seeded.status !== 0) {
      const detail =
        seeded.error?.message || seeded.stderr?.trim() || seeded.stdout?.trim();
      throw new Error(
        [
          "Local seeding failed. If local migrations are missing, run pnpm db:migrate:local, then retry.",
          detail,
        ]
          .filter(Boolean)
          .join("\n\n"),
      );
    }
  } finally {
    await unlink(file);
    await rmdir(directory);
  }
  // The dev-only seeder prepares an existing enrolled fixture without exposing
  // public enrollment or sharing setup secrets with this CLI's HTTP client.
  const enrolled = await client.post("/api/v1/auth/dev/seed-accounts", {
    data: testFixtures ? { testFixtures: true } : {},
  });
  if (!enrolled.ok()) throw new Error("Local organizer setup failed.");
  console.log(
    testFixtures
      ? "Local D1 test events and sample accounts are ready. Choose Robin Vance in View as for organizer tools."
      : "Local D1 presets and events are ready. View as groups accounts by Application, Orientation, Active volunteers, and Access, including a patrol volunteer and an eligible medic. Choose Visitor to sign out.",
  );
} finally {
  await client.dispose();
}
