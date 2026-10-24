import { afterEach, expect, test, vi } from "vitest";
import { runUITests } from "../scripts/test-ui.mjs";
import { playwrightTarget } from "../scripts/ui-test-target.mjs";
import { main as benchmark } from "../scripts/benchmark-tests.mjs";

afterEach(() => vi.restoreAllMocks());

test("Playwright refuses missing or unmanaged local targets", () => {
  expect(() => playwrightTarget({})).toThrow("pnpm test:ui");
  for (const origin of [
    "http://localhost:4321",
    "http://127.0.0.1:4321",
    "https://localhost:4321",
    "https://127.0.0.1:4321",
    "https://[::1]:4321",
    "http://192.168.1.50:4321",
  ]) {
    expect(() => playwrightTarget({ PLAYWRIGHT_BASE_URL: origin })).toThrow(
      "shared development database",
    );
  }
  expect(() =>
    playwrightTarget({
      PLAYWRIGHT_BASE_URL: "http://localhost:4321",
      PLAYWRIGHT_ISOLATED_BASE_URL: "http://localhost:12345",
    }),
  ).toThrow("shared development database");
});

test("Playwright accepts the managed local origin and read-only HTTPS targets", () => {
  expect(
    playwrightTarget({
      PLAYWRIGHT_BASE_URL: "http://localhost:12345/",
      PLAYWRIGHT_ISOLATED_BASE_URL: "http://localhost:12345",
    }),
  ).toBe("http://localhost:12345");
  expect(
    playwrightTarget({ PLAYWRIGHT_BASE_URL: "https://preview.example.org/" }),
  ).toBe("https://preview.example.org");
  for (const value of [
    "https://user:secret@preview.example.org",
    "https://preview.example.org/path",
    "https://preview.example.org/?query=1",
    "https://preview.example.org/#fragment",
  ])
    expect(() => playwrightTarget({ PLAYWRIGHT_BASE_URL: value })).toThrow(
      "must be an origin",
    );
});

function localRun(exitCode = 0) {
  vi.spyOn(console, "log").mockImplementation(() => {});
  const stop = vi.fn(async () => {});
  const server = { origin: "http://localhost:12345", stop };
  const startServer = vi.fn(async () => server);
  const run = vi.fn(async () => exitCode);
  return { environment: {}, startServer, run, stop };
}

test.each([0, 1])(
  "UI runner cleans up after exit code %i",
  async (exitCode) => {
    const options = localRun(exitCode);
    const args = ["tests/ui/local-accounts.spec.ts", "--workers=1"];
    expect(await runUITests(args, options)).toBe(exitCode);
    expect(options.startServer).toHaveBeenCalledOnce();
    expect(options.run).toHaveBeenCalledWith(
      args,
      {
        PLAYWRIGHT_BASE_URL: "http://localhost:12345",
        PLAYWRIGHT_ISOLATED_BASE_URL: "http://localhost:12345",
      },
      undefined,
    );
    expect(options.stop).toHaveBeenCalledOnce();
  },
);

test("UI runner cleans up after a runner exception or interruption", async () => {
  const options = localRun();
  const controller = new AbortController();
  options.run.mockImplementation(async () => {
    controller.abort();
    controller.signal.throwIfAborted();
    return 0;
  });
  await expect(
    runUITests([], { ...options, signal: controller.signal }),
  ).rejects.toMatchObject({ name: "AbortError" });
  expect(options.startServer).toHaveBeenCalledWith(expect.any(String), {
    signal: controller.signal,
  });
  expect(options.stop).toHaveBeenCalledOnce();
});

test("UI runner rejects an existing local server even with inherited isolation markers", async () => {
  const options = localRun();
  await expect(
    runUITests([], {
      ...options,
      environment: {
        PLAYWRIGHT_BASE_URL: "http://localhost:4321",
        PLAYWRIGHT_ISOLATED_BASE_URL: "http://localhost:4321",
      },
    }),
  ).rejects.toThrow("shared development database");
  expect(options.startServer).not.toHaveBeenCalled();
  expect(options.run).not.toHaveBeenCalled();
});

test("deployed smoke tests do not create or stop a local server", async () => {
  const options = localRun();
  const environment = { PLAYWRIGHT_BASE_URL: "https://preview.example.org/" };
  expect(await runUITests(["--list"], { ...options, environment })).toBe(0);
  expect(options.startServer).not.toHaveBeenCalled();
  expect(options.stop).not.toHaveBeenCalled();
  expect(options.run).toHaveBeenCalledWith(
    ["--list"],
    { PLAYWRIGHT_BASE_URL: "https://preview.example.org" },
    undefined,
  );
});

test("benchmarks cannot opt into a persistent local database", async () => {
  await expect(
    benchmark(["--local-url", "http://localhost:4321"]),
  ).rejects.toThrow("Unknown option '--local-url'");
});
