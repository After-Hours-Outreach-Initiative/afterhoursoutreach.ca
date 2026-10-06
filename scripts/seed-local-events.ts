import { spawnSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { mkdir, mkdtemp, rmdir, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { request } from "@playwright/test";
import { unstable_readConfig as readConfig } from "wrangler";
import { fixtureUserId, localEventFixtures } from "./local-event-fixtures";

const root = fileURLToPath(new URL("../", import.meta.url));
if (process.argv.length !== 2)
  throw new Error("Usage: pnpm db:seed:local (local only; no arguments)");
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

function authenticatorCode(key: string) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const bits = [...key.replace(/=+$/, "")]
    .map((letter) => alphabet.indexOf(letter).toString(2).padStart(5, "0"))
    .join("");
  const secret = Buffer.from(
    bits.match(/.{8}/g)!.map((byte) => parseInt(byte, 2)),
  );
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)));
  const digest = createHmac("sha1", secret).update(counter).digest();
  return String(
    (digest.readUInt32BE(digest[digest.length - 1] & 15) & 0x7fffffff) %
      1_000_000,
  ).padStart(6, "0");
}

const client = await request.newContext({
  baseURL: origin.origin,
  extraHTTPHeaders: { origin: origin.origin },
});
try {
  // Confirm the server is actually in development before making any writes.
  const listing = await client.get("/api/auth/dev/users");
  if (!listing.ok())
    throw new Error(
      "Start the local dev server and apply local migrations before seeding.",
    );
  const temporaryRoot = join(tmpdir(), "opencode");
  await mkdir(temporaryRoot, { recursive: true });
  const directory = await mkdtemp(join(temporaryRoot, "local-events-"));
  const file = join(directory, "fixtures.sql");
  try {
    await writeFile(file, localEventFixtures().join(";\n") + ";\n", {
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
    if (seeded.error || seeded.status !== 0)
      throw new Error(
        "Local seeding failed. Check that all local migrations are applied.",
      );
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
  await post("/api/auth/dev/switch-user", { userId: fixtureUserId("robin") });
  const current = await (await client.get("/api/auth/get-session")).json();
  if (!current?.user?.twoFactorEnabled) {
    // Enroll through the real auth backend; never fake the enabled flag or
    // commit an authenticator secret. View as handles verified dev sessions.
    const setup = await post("/api/auth/two-factor/enable", { method: "totp" });
    const key = new URL(setup.totpURI).searchParams.get("secret")!;
    await post("/api/auth/two-factor/verify-totp", {
      code: authenticatorCode(key),
    });
  }
  await post("/api/auth/sign-out", {});
  console.log(
    "Local D1 test events and sample accounts are ready. Choose Robin Vance in View as for organizer tools.",
  );
} finally {
  await client.dispose();
}
