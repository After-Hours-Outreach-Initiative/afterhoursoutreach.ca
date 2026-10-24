import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rmdir, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { request } from "@playwright/test";
import { unstable_readConfig as readConfig } from "wrangler";
import {
  localAccountFixtures,
  localAccountUserId,
} from "./local-account-fixtures";
import { fixtureUserId, localEventFixtures } from "./local-event-fixtures";
import { localAuthenticatorCode } from "../src/dev/server/authenticator-code";

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
  const post = async (path: string, data: object) => {
    const result = await client.post(path, { data });
    if (!result.ok())
      throw new Error(`Local organizer setup failed at ${path}.`);
    return result.json();
  };
  await post("/api/v1/auth/dev/switch-user", {
    userId: testFixtures
      ? fixtureUserId("robin")
      : localAccountUserId("organizer"),
  });
  const current = await (await client.get("/api/v1/auth/get-session")).json();
  if (!current?.user?.twoFactorEnabled) {
    // Enroll through the real auth backend; never fake the enabled flag or
    // commit an authenticator secret. View as handles verified dev sessions.
    const setup = await post("/api/v1/auth/two-factor/enable", {
      method: "totp",
    });
    const key = new URL(setup.totpURI).searchParams.get("secret")!;
    await post("/api/v1/auth/two-factor/verify-totp", {
      code: localAuthenticatorCode(key),
    });
  }
  await post("/api/v1/auth/sign-out", {});
  console.log(
    testFixtures
      ? "Local D1 test events and sample accounts are ready. Choose Robin Vance in View as for organizer tools."
      : "Local D1 manual presets and events are ready: Not applied, Applied, Accepted, Inactive, Organizer. Choose Visitor in View as to sign out.",
  );
} finally {
  await client.dispose();
}
