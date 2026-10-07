import { spawn, execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createWriteStream, existsSync, readdirSync } from "node:fs";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { parseArgs, stripVTControlCharacters } from "node:util";
import { format } from "prettier";
import { chromium } from "@playwright/test";
import { renderReport } from "./test-benchmark-report.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const reporter = join(root, "scripts/test-benchmark-reporter.mjs");
const round = (value) => Math.round(value * 1000) / 1000;
const git = (...args) =>
  execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
const filePath = (file) => relative(root, file).replaceAll("\\", "/");
const testFiles = (directory) =>
  readdirSync(join(root, directory))
    .filter((name) => name.endsWith(".test.ts"))
    .sort()
    .map((name) => join(directory, name));

export function nodeResult(report) {
  if (!report.summary)
    throw new Error("Node reporter did not return a summary.");
  const cases = report.cases.map((item) => ({
    ...item,
    file: filePath(item.file),
    durationMs: round(item.durationMs),
    container: report.cases.some(
      (child) =>
        child.file === item.file &&
        child.names.length > item.names.length &&
        item.names.every((name, index) => child.names[index] === name),
    ),
  }));
  if (
    cases.filter((item) => item.type === "test").length !==
    report.summary.counts.tests
  )
    throw new Error(
      "Node test inventory does not match its reported test count.",
    );
  return {
    counts: report.summary.counts,
    runnerMs: round(report.summary.duration_ms),
    cases,
  };
}

export function browserResult(report) {
  const cases = [];
  function visit(suite, parents = []) {
    const names = suite.column ? [...parents, suite.title] : parents;
    for (const spec of suite.specs ?? []) {
      for (const test of spec.tests) {
        cases.push({
          file: `tests/ui/${spec.file}`,
          names: [
            ...names,
            spec.title,
            ...(test.projectName ? [test.projectName] : []),
          ],
          nesting: 0,
          type: "test",
          container: false,
          status:
            {
              expected: "passed",
              unexpected: "failed",
              skipped: "skipped",
              flaky: "flaky",
            }[test.status] ?? "failed",
          // Include all retry attempts, rather than hiding their runtime cost.
          durationMs: test.results.reduce(
            (sum, result) => sum + result.duration,
            0,
          ),
          errors: test.results.flatMap((result) =>
            (result.errors ?? []).map((error) =>
              stripVTControlCharacters(error.message),
            ),
          ),
          ...(test.annotations.find((item) => item.type === "skip") && {
            skipReason: test.annotations.find((item) => item.type === "skip")
              .description,
          }),
        });
      }
    }
    for (const child of suite.suites ?? []) visit(child, names);
  }
  for (const suite of report.suites) visit(suite);
  const counts = {
    tests: cases.length,
    passed: 0,
    failed: 0,
    skipped: 0,
    flaky: 0,
  };
  for (const item of cases) counts[item.status]++;
  return {
    counts,
    runnerMs: round(report.stats.duration),
    workers: report.config.workers,
    errors: report.errors,
    cases,
  };
}

async function command(args, log, cwd = root, environment = {}) {
  const started = performance.now();
  const output = createWriteStream(log);
  let stdout = "";
  const exitCode = await new Promise((accept, reject) => {
    const child = spawn("pnpm", args, {
      cwd,
      env: { ...process.env, CLOUDFLARE_ENV: "", ...environment },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      output.write(chunk);
    });
    child.stderr.on("data", (chunk) => output.write(chunk));
    child.on("error", reject);
    child.on("close", (code) => accept(code ?? 1));
  }).finally(() => output.end());
  return { exitCode, wallMs: round(performance.now() - started), stdout };
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

async function localServer(logs) {
  const temporaryRoot = join(os.tmpdir(), "opencode");
  await mkdir(temporaryRoot, { recursive: true });
  const directory = await mkdtemp(join(temporaryRoot, "test-benchmark-"));
  let started = false;
  const stop = async () => {
    if (started) {
      const result = await command(
        ["exec", "astro", "dev", "stop"],
        join(logs, "dev-stop.log"),
        directory,
      );
      if (result.exitCode) {
        throw new Error(
          `Could not stop benchmark server in ${directory}; retained its files.`,
        );
      }
    }
    // Only remove the specific temporary directory created by this invocation.
    await rm(directory, { recursive: true });
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
      if (!existsSync(join(root, file))) continue;
      await mkdir(dirname(join(directory, file)), { recursive: true });
      await copyFile(join(root, file), join(directory, file));
    }
    await symlink(
      join(root, "node_modules"),
      join(directory, "node_modules"),
      "dir",
    );
    // Never copy the developer's secrets or persisted database into the benchmark.
    await writeFile(
      join(directory, ".dev.vars"),
      `APP_ENV="local"\nAUTH_BASE_URL=""\nBETTER_AUTH_SECRET="${randomBytes(32).toString("hex")}"\nRESEND_API_KEY="benchmark-local-no-email"\n`,
      { mode: 0o600 },
    );
    const migrated = await command(
      ["db:migrate:local"],
      join(logs, "dev-migrations.log"),
      directory,
    );
    if (migrated.exitCode)
      throw new Error("Benchmark local database migrations failed.");
    const origin = `http://localhost:${await unusedPort()}`;
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
    );
    started = true;
    if (server.exitCode)
      throw new Error("Benchmark development server failed to start.");
    const deadline = Date.now() + 120_000;
    let ready = false;
    while (Date.now() < deadline) {
      try {
        const response = await fetch(`${origin}/api/auth/dev/users`, {
          signal: AbortSignal.timeout(5000),
        });
        ready = response.ok;
        await response.body?.cancel();
        if (ready) break;
      } catch {
        // The background process may still be compiling its first routes.
      }
      await new Promise((accept) => setTimeout(accept, 500));
    }
    if (!ready)
      throw new Error("Benchmark development server did not become ready.");
    const seeded = await command(
      ["db:seed:local"],
      join(logs, "dev-seed.log"),
      directory,
      { LOCAL_BASE_URL: origin },
    );
    if (seeded.exitCode)
      throw new Error("Benchmark local fixture seeding failed.");
    return { origin, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}

export async function main(args = process.argv.slice(2)) {
  const { values } = parseArgs({
    args,
    options: {
      runs: { type: "string", default: "3" },
      warmups: { type: "string", default: "1" },
      baseline: { type: "string" },
      "local-url": { type: "string" },
      "deployed-url": { type: "string" },
      report: { type: "string", default: "test-results/benchmarks/latest.md" },
      output: {
        type: "string",
        default: "test-results/benchmarks/latest.json",
      },
      help: { type: "boolean", default: false },
    },
  });
  if (values.help) {
    console.log(
      "Usage: pnpm test:benchmark [--runs 3] [--warmups 1] [--baseline FILE] [--deployed-url HTTPS_URL] [--local-url http://localhost:PORT] [--report FILE.md] [--output FILE.json]",
    );
    return;
  }
  const runs = Number(values.runs);
  const warmups = Number(values.warmups);
  if (
    !Number.isSafeInteger(runs) ||
    runs < 1 ||
    !Number.isSafeInteger(warmups) ||
    warmups < 0
  )
    throw new Error(
      "Runs must be a positive integer and warmups a non-negative integer.",
    );
  for (const [name, protocol] of [
    ["local-url", "http:"],
    ["deployed-url", "https:"],
  ]) {
    if (!values[name]) continue;
    const url = new URL(values[name]);
    if (
      url.protocol !== protocol ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash ||
      (name === "local-url" && url.hostname !== "localhost")
    )
      throw new Error(
        `${name} must be a ${protocol} origin${name === "local-url" ? " on localhost" : ""}.`,
      );
  }
  const baseline = values.baseline
    ? JSON.parse(await readFile(resolve(root, values.baseline), "utf8"))
    : null;
  if (baseline && baseline.schemaVersion !== 1)
    throw new Error("Unsupported baseline schema.");
  for (const path of [values.report, values.output]) {
    if (
      values.baseline &&
      resolve(root, path) === resolve(root, values.baseline)
    )
      throw new Error("Comparison output must not overwrite the baseline.");
  }
  const startedAt = new Date().toISOString();
  const logs = join(
    root,
    "test-results/benchmarks",
    startedAt.replaceAll(/[:.]/g, "-"),
  );
  await mkdir(logs, { recursive: true });
  const versions = Object.fromEntries(
    await Promise.all(
      ["astro", "wrangler", "tsx", "@playwright/test", "miniflare"].map(
        async (name) => [
          name,
          JSON.parse(
            await readFile(
              join(root, "node_modules", name, "package.json"),
              "utf8",
            ),
          ).version,
        ],
      ),
    ),
  );
  const data = {
    schemaVersion: 1,
    startedAt,
    commit: git("rev-parse", "HEAD"),
    branch: git("branch", "--show-current"),
    workingTree: git("status", "--short"),
    environment: {
      node: process.version,
      pnpm: execFileSync("pnpm", ["--version"], {
        cwd: root,
        encoding: "utf8",
      }).trim(),
      platform: process.platform,
      arch: process.arch,
      cpu: os.cpus()[0]?.model,
      logicalCpus: os.cpus().length,
      availableParallelism: os.availableParallelism(),
      memoryGiB: round(os.totalmem() / 1024 ** 3),
      versions,
    },
    options: {
      runs,
      warmups,
      localServer: values["local-url"] ? "existing" : "isolated",
      deployedUrl: values["deployed-url"] ?? null,
    },
    logs: filePath(logs),
    phases: [],
    warmupFailures: [],
  };
  const browserExecutable =
    process.env.CHROMIUM_PATH ??
    (existsSync("/usr/bin/chromium")
      ? "/usr/bin/chromium"
      : chromium.executablePath());
  data.environment.chromium = execFileSync(browserExecutable, ["--version"], {
    encoding: "utf8",
  }).trim();
  const phases = new Map();
  async function measure(
    id,
    label,
    commandArgs,
    iteration,
    kind,
    environment = {},
  ) {
    let phase = phases.get(id);
    if (!phase) {
      phase = {
        id,
        label,
        kind,
        command: ["pnpm", ...commandArgs].join(" "),
        samples: [],
      };
      phases.set(id, phase);
    }
    const prefix = join(logs, `${iteration}-${id}`);
    const resultFile = `${prefix}.json`;
    if (kind === "node" && commandArgs.length === 3) {
      const sample = {
        exitCode: 0,
        wallMs: 0,
        runnerMs: 0,
        counts: { tests: 0, passed: 0, failed: 0, skipped: 0 },
        cases: [],
        note: "No files matched; Node auto-discovery was not launched.",
      };
      console.log(`${iteration} ${label}: no test files`);
      if (!iteration.startsWith("warmup")) phase.samples.push(sample);
      return sample;
    }
    const launchArgs =
      kind === "node"
        ? [
            "exec",
            "tsx",
            "--test",
            `--test-reporter=${reporter}`,
            `--test-reporter-destination=${resultFile}`,
            ...commandArgs.slice(3),
          ]
        : kind === "browser"
          ? [...commandArgs, "--output", `${prefix}-artifacts`]
          : commandArgs;
    const execution = await command(launchArgs, `${prefix}.log`, root, {
      ...environment,
      ...(kind === "browser" && { PLAYWRIGHT_JSON_OUTPUT_FILE: resultFile }),
    });
    const sample = { wallMs: execution.wallMs, exitCode: execution.exitCode };
    if (kind !== "build") {
      try {
        const report = JSON.parse(await readFile(resultFile, "utf8"));
        Object.assign(
          sample,
          kind === "node" ? nodeResult(report) : browserResult(report),
        );
      } catch (error) {
        sample.error = error.message;
        sample.exitCode ||= 1;
      }
    }
    const success = sample.exitCode === 0 && !sample.counts?.flaky;
    console.log(
      `${iteration} ${label}: ${(sample.wallMs / 1000).toFixed(2)}s${sample.counts ? `; ${sample.counts.tests} tests, ${sample.counts.passed} passed, ${sample.counts.skipped} skipped` : ""}${success ? "" : " (FAILED; see raw logs)"}`,
    );
    if (iteration.startsWith("warmup")) {
      if (!success) data.warmupFailures.push({ phase: id, ...sample });
    } else phase.samples.push(sample);
    return sample;
  }
  let server;
  const setupStart = performance.now();
  try {
    server = values["local-url"]
      ? { origin: new URL(values["local-url"]).origin, stop: async () => {} }
      : await localServer(logs);
    data.setupMs = round(performance.now() - setupStart);
    for (let index = -warmups; index < runs; index++) {
      const iteration =
        index < 0 ? `warmup-${index + warmups + 1}` : `run-${index + 1}`;
      await measure(
        "unit",
        "Node unit / local-runtime tests",
        ["exec", "tsx", "--test", ...testFiles("tests")],
        iteration,
        "node",
      );
      const production = await measure(
        "build-production",
        "Production build",
        ["build"],
        iteration,
        "build",
      );
      if (!production.exitCode)
        await measure(
          "worker",
          "Production Worker tests",
          ["exec", "tsx", "--test", ...testFiles("tests/worker")],
          iteration,
          "node",
        );
      const preview = await measure(
        "build-preview",
        "Preview build",
        ["build:preview"],
        iteration,
        "build",
      );
      if (!preview.exitCode)
        await measure(
          "preview",
          "Preview Worker tests",
          ["exec", "tsx", "--test", ...testFiles("tests/preview")],
          iteration,
          "node",
        );
      await measure(
        "ui-local",
        "Local browser tests",
        ["exec", "playwright", "test", "--reporter=json"],
        iteration,
        "browser",
        { PLAYWRIGHT_BASE_URL: server.origin },
      );
      if (values["deployed-url"])
        await measure(
          "ui-deployed",
          "Deployed browser smoke tests",
          [
            "exec",
            "playwright",
            "test",
            "tests/ui/deployed-site.spec.ts",
            "--reporter=json",
          ],
          iteration,
          "browser",
          { PLAYWRIGHT_BASE_URL: new URL(values["deployed-url"]).origin },
        );
    }
  } finally {
    await server?.stop();
  }
  data.phases = [...phases.values()];
  data.finishedAt = new Date().toISOString();
  data.inventoryStable = data.phases.every((phase) =>
    phase.samples.every(
      (sample) =>
        JSON.stringify(
          (sample.cases ?? [])
            .map(({ file, names, type }) => [file, names, type])
            .sort(),
        ) ===
        JSON.stringify(
          (phase.samples[0]?.cases ?? [])
            .map(({ file, names, type }) => [file, names, type])
            .sort(),
        ),
    ),
  );
  data.valid =
    data.inventoryStable &&
    !data.warmupFailures.length &&
    data.phases.every(
      (phase) =>
        phase.samples.length === runs &&
        phase.samples.every(
          (sample) => sample.exitCode === 0 && !sample.counts?.flaky,
        ),
    );
  for (const path of [values.report, values.output])
    await mkdir(dirname(resolve(root, path)), { recursive: true });
  await writeFile(
    resolve(root, values.output),
    await format(JSON.stringify(data), { parser: "json" }),
  );
  await writeFile(
    resolve(root, values.report),
    await format(renderReport(data, baseline, values), { parser: "markdown" }),
  );
  console.log(
    `Report: ${values.report}\nData: ${values.output}\nRaw logs: ${data.logs}`,
  );
  if (!data.valid) process.exitCode = 1;
  return data;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
