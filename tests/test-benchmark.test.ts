import { expect, test } from "vitest";
import { fileURLToPath } from "node:url";
import { vitestResult } from "../scripts/benchmark-tests.mjs";
import { renderReport } from "../scripts/test-benchmark-report.mjs";

const file = fileURLToPath(new URL("./example.test.ts", import.meta.url));
function result(statuses = ["passed"]) {
  return {
    numTotalTests: statuses.length,
    numPassedTests: statuses.filter((status) => status === "passed").length,
    numFailedTests: statuses.filter((status) => status === "failed").length,
    numPendingTests: statuses.filter((status) =>
      ["pending", "skipped", "disabled"].includes(status),
    ).length,
    numTodoTests: statuses.filter((status) => status === "todo").length,
    startTime: 100,
    success: !statuses.includes("failed"),
    testResults: [
      {
        name: file,
        startTime: 110,
        endTime: 150,
        status: statuses.includes("failed") ? "failed" : "passed",
        message: "",
        assertionResults: statuses.map((status, index) => ({
          ancestorTitles: ["", "suite"],
          title: `case ${index}`,
          status,
          duration: 3,
          failureMessages: status === "failed" ? ["Assertion failed"] : [],
        })),
      },
    ],
  };
}

test("Vitest benchmark results count leaf cases, skips, todos and failures", () => {
  const parsed = vitestResult(result(["passed", "pending", "todo", "failed"]));
  expect(parsed.counts).toEqual({
    tests: 4,
    passed: 1,
    skipped: 1,
    todo: 1,
    failed: 1,
  });
  expect(parsed.cases[0]).toMatchObject({
    file: "tests/example.test.ts",
    names: ["suite", "case 0"],
    nesting: 0,
    container: false,
    durationMs: 3,
  });
  expect(parsed.cases[3].errors).toEqual(["Assertion failed"]);
  expect(parsed.files).toEqual([
    { file: "tests/example.test.ts", durationMs: 40 },
  ]);
  expect(parsed.runnerMs).toBe(50);
});

test("a failed Vitest fixture is not counted as a passing benchmark", () => {
  const report = result();
  report.success = false;
  report.testResults[0].status = "failed";
  report.testResults[0].message = "beforeAll failed";
  const parsed = vitestResult(report);
  expect(parsed.counts.passed).toBe(1);
  expect(parsed.reportPassed).toBe(false);
  expect(parsed.errors).toEqual(["beforeAll failed"]);
});

test("Vitest benchmark results reject missing summaries, count mismatches and unknown statuses", () => {
  expect(() => vitestResult({})).toThrow("valid summary");
  expect(() => vitestResult({ ...result(), numTotalTests: 2 })).toThrow(
    "reported test count",
  );
  expect(() => vitestResult(result(["unknown"]))).toThrow(
    "Unknown Vitest status",
  );
});

test("Vitest benchmark results retain a passing empty inventory without inventing cases", () => {
  const parsed = vitestResult({ ...result([]), testResults: [] });
  expect(parsed.counts.tests).toBe(0);
  expect(parsed.cases).toEqual([]);
  expect(parsed.reportPassed).toBe(true);
});

test("benchmark comparisons distinguish retired Node containers from lost leaf coverage", () => {
  const parsed = vitestResult(result());
  const current = {
    startedAt: "now",
    branch: "test",
    commit: "test",
    valid: true,
    options: {
      runs: 1,
      warmups: 0,
      localServer: "isolated",
      deployedUrl: null,
    },
    setupMs: 0,
    environment: { versions: {} },
    workingTree: "",
    logs: "logs",
    warmupFailures: [],
    phases: [
      {
        id: "unit",
        label: "unit",
        kind: "vitest",
        command: "vitest",
        samples: [{ ...parsed, exitCode: 0, wallMs: 50 }],
      },
    ],
  };
  const parent = { ...parsed.cases[0], names: ["suite"], container: true };
  const baseline = {
    ...current,
    startedAt: "before",
    phases: [
      {
        ...current.phases[0],
        kind: "node",
        samples: [
          {
            ...current.phases[0].samples[0],
            cases: [parent, parsed.cases[0]],
            counts: { ...parsed.counts, tests: 2, passed: 2 },
          },
        ],
      },
    ],
  };
  expect(
    renderReport(current, baseline, {
      baseline: "baseline.json",
      output: "after.json",
    }),
  ).toContain("Leaf cases: 1 → 1. Parent/container counts: 1 → 0.");
});
