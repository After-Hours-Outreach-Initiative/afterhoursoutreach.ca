import { spawn, execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import {
  copyFile,
  mkdir,
  mkdtemp,
  open,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));

/**
 * @param {string[]} args
 * @param {string} log
 * @param {string} cwd
 * @param {Record<string, string | undefined>} [environment]
 * @param {AbortSignal} [signal]
 * @returns {Promise<number>}
 */
async function command(args, log, cwd, environment = {}, signal) {
  await mkdir(dirname(log), { recursive: true });
  const output = await open(log, "w");
  try {
    return await new Promise((accept, reject) => {
      // The copy shares installed modules; never let pnpm reinstall through it.
      const child = spawn(
        "pnpm",
        ["--config.verify-deps-before-run=false", ...args],
        {
          cwd,
          env: { ...process.env, CLOUDFLARE_ENV: "", ...environment },
          stdio: ["ignore", output.fd, output.fd],
          signal,
        },
      );
      let error;
      child.on("error", (failure) => (error = failure));
      child.on("close", (code) => (error ? reject(error) : accept(code ?? 1)));
    });
  } finally {
    await output.close();
  }
}

async function unusedPort() {
  const server = createServer();
  await new Promise((accept, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", accept);
  });
  const port = server.address().port;
  await new Promise((accept) => server.close(accept));
  return port;
}

/**
 * @param {string} logs
 * @param {{ signal?: AbortSignal }} [options]
 */
export async function startLocalTestServer(logs, { signal } = {}) {
  await mkdir(logs, { recursive: true });
  const temporaryRoot = join(tmpdir(), "opencode");
  await mkdir(temporaryRoot, { recursive: true });
  const directory = await mkdtemp(join(temporaryRoot, "ui-tests-"));
  let started = false;
  const stop = async () => {
    if (started) {
      const exitCode = await command(
        ["exec", "astro", "dev", "stop"],
        join(logs, "dev-stop.log"),
        directory,
      );
      if (exitCode) {
        throw new Error(
          `Could not stop test server in ${directory}; retained its files. See ${logs}.`,
        );
      }
      started = false;
    }
    try {
      await copyFile(
        join(directory, ".astro/dev.log"),
        join(logs, "dev-server.log"),
      );
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    // Only remove the specific temporary directory created by this invocation.
    await rm(directory, { recursive: true, force: true });
  };
  try {
    const files = execFileSync(
      "git",
      ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
      { cwd: root, encoding: "utf8" },
    )
      .split("\0")
      .filter(Boolean);
    for (const file of new Set(files)) {
      signal?.throwIfAborted();
      // Never copy persisted state, build outputs, or developer secrets.
      if (
        /(^|\/)(node_modules|\.wrangler|\.astro|dist|dist-preview|test-results)(\/|$)/.test(
          file,
        ) ||
        /(^|\/)(\.env|\.dev\.vars)(\.|$)/.test(file) ||
        !existsSync(join(root, file))
      )
        continue;
      await mkdir(dirname(join(directory, file)), { recursive: true });
      await copyFile(join(root, file), join(directory, file));
    }
    // Share installed packages, not mutable Astro/Vite caches under node_modules.
    await mkdir(join(directory, "node_modules"));
    for (const entry of await readdir(join(root, "node_modules"), {
      withFileTypes: true,
    })) {
      if (entry.name.startsWith(".") && ![".bin", ".pnpm"].includes(entry.name))
        continue;
      await symlink(
        join(root, "node_modules", entry.name),
        join(directory, "node_modules", entry.name),
        "dir",
      );
    }
    await writeFile(
      join(directory, ".dev.vars"),
      `APP_ENV="local"\nAUTH_BASE_URL=""\nBETTER_AUTH_SECRET="${randomBytes(32).toString("hex")}"\nRESEND_API_KEY="ui-tests-local-no-email"\n`,
      { mode: 0o600 },
    );
    const migrated = await command(
      ["db:migrate:local"],
      join(logs, "dev-migrations.log"),
      directory,
      {},
      signal,
    );
    if (migrated)
      throw new Error(`Test database migrations failed. See ${logs}.`);
    const origin = `http://localhost:${await unusedPort()}`;
    started = true;
    const server = await command(
      [
        "exec",
        "astro",
        "dev",
        "--background",
        "--host",
        "localhost",
        "--port",
        new URL(origin).port,
      ],
      join(logs, "dev-start.log"),
      directory,
      {},
      signal,
    );
    if (server)
      throw new Error(`Test development server failed to start. See ${logs}.`);
    const deadline = Date.now() + 120_000;
    let ready = false;
    while (Date.now() < deadline) {
      signal?.throwIfAborted();
      try {
        const timeout = AbortSignal.timeout(5000);
        const response = await fetch(`${origin}/api/v1/auth/dev/users`, {
          signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        });
        ready = response.ok;
        await response.body?.cancel();
        if (ready) break;
      } catch {
        signal?.throwIfAborted();
        // The background process may still be compiling its first routes.
      }
      await new Promise((accept) => setTimeout(accept, 500));
    }
    if (!ready)
      throw new Error(
        `Test development server did not become ready. See ${logs}.`,
      );
    const seeded = await command(
      ["db:seed:local"],
      join(logs, "dev-seed.log"),
      directory,
      { LOCAL_BASE_URL: origin },
      signal,
    );
    if (seeded) throw new Error(`Test fixture seeding failed. See ${logs}.`);
    return { origin, directory, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}
