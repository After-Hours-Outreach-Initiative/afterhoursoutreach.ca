import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startLocalTestServer } from "./local-test-server.mjs";
import { playwrightTarget } from "./ui-test-target.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const cli = createRequire(import.meta.url).resolve("@playwright/test/cli");

/**
 * @param {string[]} args
 * @param {Record<string, string | undefined>} environment
 * @param {AbortSignal} [signal]
 * @returns {Promise<number>}
 */
async function runPlaywright(args, environment, signal) {
  return await new Promise((accept, reject) => {
    const child = spawn(process.execPath, [cli, "test", ...args], {
      cwd: root,
      env: environment,
      stdio: "inherit",
      signal,
      killSignal: "SIGINT",
    });
    let error;
    child.on("error", (failure) => (error = failure));
    child.on("close", (code) => (error ? reject(error) : accept(code ?? 1)));
  });
}

/**
 * @typedef {{ origin: string, stop: () => Promise<void> }} LocalTestServer
 * @param {string[]} [args]
 * @param {{
 *   environment?: Record<string, string | undefined>,
 *   startServer?: (logs: string, options?: { signal?: AbortSignal }) => Promise<LocalTestServer>,
 *   run?: (args: string[], environment: Record<string, string | undefined>, signal?: AbortSignal) => Promise<number>,
 *   signal?: AbortSignal
 * }} [options]
 */
export async function runUITests(
  args = process.argv.slice(2),
  {
    environment = process.env,
    startServer = startLocalTestServer,
    run = runPlaywright,
    signal,
  } = {},
) {
  if (environment.PLAYWRIGHT_BASE_URL) {
    // Only read-only deployed smoke tests may opt into an existing server.
    const origin = playwrightTarget({
      ...environment,
      PLAYWRIGHT_ISOLATED_BASE_URL: "",
    });
    return await run(
      args,
      { ...environment, PLAYWRIGHT_BASE_URL: origin },
      signal,
    );
  }
  const logs = join(
    root,
    "test-results/ui",
    new Date().toISOString().replaceAll(/[:.]/g, "-"),
  );
  const server = await startServer(logs, { signal });
  try {
    console.log(`Isolated browser test server: ${server.origin}`);
    return await run(
      args,
      {
        ...environment,
        PLAYWRIGHT_BASE_URL: server.origin,
        PLAYWRIGHT_ISOLATED_BASE_URL: server.origin,
      },
      signal,
    );
  } finally {
    await server.stop();
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const controller = new AbortController();
  const interrupt = (signal) => {
    process.exitCode = signal === "SIGINT" ? 130 : 143;
    controller.abort();
  };
  const onSigint = () => interrupt("SIGINT");
  const onSigterm = () => interrupt("SIGTERM");
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);
  runUITests(process.argv.slice(2), { signal: controller.signal })
    .then((code) => {
      if (!controller.signal.aborted) process.exitCode = code;
    })
    .catch((error) => {
      if (!controller.signal.aborted || error.name !== "AbortError") {
        console.error(error);
        process.exitCode = 1;
      }
    })
    .finally(() => {
      process.off("SIGINT", onSigint);
      process.off("SIGTERM", onSigterm);
    });
}
