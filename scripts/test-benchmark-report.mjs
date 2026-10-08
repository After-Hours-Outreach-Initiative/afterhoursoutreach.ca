export function statistics(values) {
  if (!values.length) return { median: 0, min: 0, max: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return {
    median:
      sorted.length % 2
        ? sorted[middle]
        : (sorted[middle - 1] + sorted[middle]) / 2,
    min: sorted[0],
    max: sorted.at(-1),
  };
}

const seconds = (milliseconds) => `${(milliseconds / 1000).toFixed(3)} s`;
const escape = (value) =>
  String(value).replaceAll("|", "\\|").replaceAll(/\r?\n/g, " ");
const table = (headings, rows) =>
  [
    `| ${headings.join(" | ")} |`,
    `| ${headings.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.map(escape).join(" | ")} |`),
  ].join("\n");
const caseId = (item) => JSON.stringify([item.file, item.names]);
const testCases = (sample) =>
  (sample.cases ?? []).filter((item) => item.type === "test");

export function inventory(data) {
  const cases = new Map();
  for (const phase of data.phases) {
    for (const sample of phase.samples) {
      for (const item of testCases(sample)) {
        const id = caseId(item);
        if (!cases.has(id))
          cases.set(id, { ...item, profiles: new Set(), durations: [] });
        const entry = cases.get(id);
        entry.profiles.add(`${phase.id}: ${item.status}`);
        if (item.status !== "skipped" && item.status !== "todo")
          entry.durations.push(item.durationMs);
      }
    }
  }
  return cases;
}

export function renderReport(data, baseline, options) {
  const cases = inventory(data);
  const files = [
    ...new Set([...cases.values()].map((item) => item.file)),
  ].sort();
  const containers = [...cases.values()].filter(
    (item) => item.container,
  ).length;
  const executed = [...cases.values()].filter(
    (item) => item.durations.length,
  ).length;
  const repeatedCommand = `pnpm test:benchmark --baseline ${options.baseline ?? options.output}${data.options.deployedUrl ? ` --deployed-url ${data.options.deployedUrl}` : ""}`;
  const lines = [
    "# Test benchmark report",
    "",
    `Measured ${data.startedAt} on \`${data.branch}\` at \`${data.commit}\`.`,
    "",
    `**${data.valid ? "Valid baseline: all measured runs and warm-ups passed." : "Failed or incomplete runs: do not treat this as a passing performance baseline."}**`,
    "",
    `- ${cases.size} distinct registered tests across ${files.length} test files; ${executed} executed in at least one profile.`,
    `- ${cases.size - containers} leaf cases and ${containers} legacy parent/container tests. Vitest describes are suites, not extra test cases; historical Node parent timings include their children.`,
    `- ${data.options.warmups} untimed warm-up round(s), then ${data.options.runs} measured rounds. Suites run sequentially; each test runner retains its normal parallelism.`,
    `- Local browser data: ${data.options.localServer === "isolated" ? "a temporary copy of the current working tree, a fresh local D1 database and synthetic fixtures; no developer server/database/secrets reused" : "the supplied existing localhost server/database"}. State is reused across rounds, so test-created accounts accumulate.`,
    `- One-off development-server/database setup: ${seconds(data.setupMs)}; excluded from measured suite times. Builds, runner startup and browser startup are included in their respective wall times.`,
    `- ${data.options.deployedUrl ? `Deployed smoke-test target: ${data.options.deployedUrl}. These read-only network checks are reported separately.` : "Deployed smoke tests were not run. Their local-profile skips are not counted as passes."}`,
    "- This is a warm-cache baseline, not a cold-cache benchmark. Per-test timings do not sum to elapsed time because tests can overlap.",
    "- Timing and test-count reductions do not prove redundancy or preserved coverage. Review what each removed test protects.",
    "",
    "## Repeat and compare",
    "",
    "Keep the baseline JSON unchanged and run:",
    "",
    "```sh",
    repeatedCommand,
    "```",
    "",
    "The default outputs are `test-results/benchmarks/latest.md` and `test-results/benchmarks/latest.json`. The report lists test-count/runtime deltas and added/removed test names. Use the same machine, package versions, target, concurrency and run count. Avoid other builds/tests while measuring. Small changes within the observed min–max range may just be noise.",
    "",
    "Use `--runs N` or `--warmups N` to change sampling, `--report FILE.md` and `--output FILE.json` to retain another snapshot, or `--local-url http://localhost:PORT` to opt into an existing development database. The default starts and stops its own Astro background server; it never stops your existing server. No deployment or remote database mutation is performed.",
    "",
    "## Environment",
    "",
    table(
      ["Setting", "Value"],
      [
        ["Node / pnpm", `${data.environment.node} / ${data.environment.pnpm}`],
        ["Platform", `${data.environment.platform} ${data.environment.arch}`],
        ["CPU", data.environment.cpu],
        [
          "Logical CPUs / available parallelism",
          `${data.environment.logicalCpus} / ${data.environment.availableParallelism}`,
        ],
        ["Memory", `${data.environment.memoryGiB} GiB`],
        ...Object.entries(data.environment.versions),
        ["Chromium", data.environment.chromium ?? "unknown"],
        [
          "Playwright configured workers",
          data.phases.find((phase) => phase.kind === "browser")?.samples[0]
            ?.workers ?? "unknown",
        ],
      ],
    ),
    "",
    "Working-tree changes at the start (the snapshot includes these changes, not just HEAD):",
    "",
    "```text",
    data.workingTree || "Clean",
    "```",
    "",
    "## Suite and build benchmarks",
    "",
    table(
      [
        "Phase",
        "Files",
        "Tests",
        "Passed",
        "Failed",
        "Skipped",
        "Median wall",
        "Min",
        "Max",
      ],
      data.phases.map((phase) => {
        const timing = statistics(phase.samples.map((sample) => sample.wallMs));
        const counts = phase.samples[0]?.counts;
        return [
          phase.label,
          counts
            ? new Set(testCases(phase.samples[0]).map((item) => item.file)).size
            : "—",
          counts?.tests ?? "—",
          counts?.passed ?? "—",
          counts?.failed ?? "—",
          counts?.skipped ?? "—",
          seconds(timing.median),
          seconds(timing.min),
          seconds(timing.max),
        ];
      }),
    ),
    "",
    "Counts above are per round, not multiplied by the number of repetitions. Local UI includes the deployed tests as skips; the deployed profile executes those same cases. Do not add profile counts to get the distinct total.",
    "",
    "### Package-command equivalents",
    "",
    table(
      ["Command/profile", "Median wall including builds", "Min", "Max"],
      [
        ["pnpm test", ["unit"]],
        ["pnpm test:accounts", ["build-production", "worker"]],
        ["pnpm test:preview", ["build-preview", "preview"]],
        ["pnpm test:ui (localhost)", ["ui-local"]],
        ...(data.options.deployedUrl
          ? [["Deployed smoke tests only", ["ui-deployed"]]]
          : []),
        [
          "All measured phases, sequential",
          data.phases.map((phase) => phase.id),
        ],
      ].map(([label, ids]) => {
        const timing = statistics(
          Array.from({ length: data.options.runs }, (_, index) =>
            ids.reduce(
              (sum, id) =>
                sum +
                (data.phases.find((phase) => phase.id === id)?.samples[index]
                  ?.wallMs ?? 0),
              0,
            ),
          ),
        );
        return [
          label,
          seconds(timing.median),
          seconds(timing.min),
          seconds(timing.max),
        ];
      }),
    ),
    "",
    "Build and test commands are launched separately so their costs are visible. The combined figures are the sum for each measured round, including both command launches; they are not measurements of one shell invocation of the package script. Vitest phases select the same projects as the package scripts. The unit phase includes Node utility tests and source-level tests inside Cloudflare's runtime. Built Worker tests remain in Node-hosted Vitest projects to exercise the actual production/preview artifacts. Empty groups are recorded as zero tests without launching a runner.",
    "",
    "## Per-file benchmarks",
    "",
    "Vitest JSON reports each file's elapsed span from its first leaf case to its last, including intervening hooks but excluding outer beforeAll/afterAll and collection. Historical Node snapshots use summed top-level durations, including setup inside parent tests; Playwright uses summed case durations. These measures are not directly equivalent. Full fixture, runner and browser costs are captured by phase wall times.",
    "",
    table(
      [
        "Profile",
        "File",
        "Tests",
        "Leaf cases",
        "Median file/test time",
        "Min",
        "Max",
      ],
      data.phases.flatMap((phase) => {
        if (phase.kind === "build") return [];
        const phaseFiles = [
          ...new Set(
            phase.samples.flatMap((sample) =>
              testCases(sample).map((item) => item.file),
            ),
          ),
        ].sort();
        return phaseFiles.map((file) => {
          const first = testCases(phase.samples[0]).filter(
            (item) => item.file === file,
          );
          const timing = statistics(
            phase.samples.map(
              (sample) =>
                sample.files?.find((item) => item.file === file)?.durationMs ??
                (sample.cases ?? [])
                  .filter((item) => item.file === file && item.nesting === 0)
                  .reduce((sum, item) => sum + item.durationMs, 0),
            ),
          );
          return [
            phase.id,
            file,
            first.length,
            first.filter((item) => !item.container).length,
            seconds(timing.median),
            seconds(timing.min),
            seconds(timing.max),
          ];
        });
      }),
    ),
    "",
    "## Complete test inventory and timings",
    "",
    "Sorted by median measured case duration, slowest first. Skipped profiles are excluded from case timing statistics. Legacy containers are marked; removing a child affects its parent's inclusive duration too. Vitest case timings exclude suite-level fixture hooks. Identities use file and full test name, not line numbers, so deleting earlier tests does not make unchanged tests appear renamed.",
    "",
    table(
      ["File", "Test", "Profiles/status", "Median", "Min", "Max"],
      [...cases.values()]
        .sort(
          (a, b) =>
            statistics(b.durations).median - statistics(a.durations).median,
        )
        .map((item) => {
          const timing = statistics(item.durations);
          return [
            item.file,
            `${item.names.join(" › ")}${item.container ? " (container)" : ""}`,
            [...item.profiles].join(", "),
            item.durations.length ? seconds(timing.median) : "not executed",
            item.durations.length ? seconds(timing.min) : "—",
            item.durations.length ? seconds(timing.max) : "—",
          ];
        }),
    ),
  ];
  if (baseline) {
    const previous = inventory(baseline);
    const previousContainers = [...previous.values()].filter(
      (item) => item.container,
    ).length;
    const currentIds = new Set(cases.keys());
    const removed = [...previous]
      .filter(([id]) => !currentIds.has(id))
      .map(([, item]) => item);
    const added = [...cases]
      .filter(([id]) => !previous.has(id))
      .map(([, item]) => item);
    lines.push(
      "",
      "## Comparison with baseline",
      "",
      `Baseline: ${baseline.startedAt}, commit \`${baseline.commit}\`. Distinct registered tests: ${previous.size} → ${cases.size} (${cases.size - previous.size >= 0 ? "+" : ""}${cases.size - previous.size}).`,
      `Leaf cases: ${previous.size - previousContainers} → ${cases.size - containers}. Parent/container counts: ${previousContainers} → ${containers}. A runner changing its suite-counting convention is not a coverage reduction.`,
    );
    if (
      JSON.stringify(data.environment) !==
        JSON.stringify(baseline.environment) ||
      JSON.stringify(data.options) !== JSON.stringify(baseline.options)
    )
      lines.push(
        "",
        "**Environment or benchmark options differ. Treat runtime deltas as non-equivalent until you repeat with matching conditions.**",
      );
    lines.push(
      "",
      table(
        [
          "Phase",
          "Tests before → after",
          "Wall before → after",
          "Delta",
          "Delta %",
        ],
        data.phases.map((phase) => {
          const old = baseline.phases.find((item) => item.id === phase.id);
          if (!old) return [phase.label, "new profile", "—", "—", "—"];
          const before = statistics(
            old.samples.map((sample) => sample.wallMs),
          ).median;
          const after = statistics(
            phase.samples.map((sample) => sample.wallMs),
          ).median;
          const delta = after - before;
          return [
            phase.label,
            `${old.samples[0]?.counts?.tests ?? "—"} → ${phase.samples[0]?.counts?.tests ?? "—"}`,
            `${seconds(before)} → ${seconds(after)}`,
            `${delta >= 0 ? "+" : ""}${seconds(delta)}`,
            before ? `${((delta / before) * 100).toFixed(1)}%` : "—",
          ];
        }),
      ),
    );
    for (const [label, items] of [
      ["Removed tests", removed],
      ["Added tests", added],
    ])
      lines.push(
        "",
        `### ${label}`,
        "",
        ...(items.length
          ? items.map((item) => `- \`${item.file}\`: ${item.names.join(" › ")}`)
          : ["None."]),
      );
  }
  const problems = data.phases.flatMap((phase) =>
    phase.samples.flatMap((sample, index) =>
      sample.exitCode || sample.counts?.flaky
        ? [
            `- ${phase.id}, run ${index + 1}: exit ${sample.exitCode}${sample.error ? `; ${sample.error}` : ""}.`,
          ]
        : [],
    ),
  );
  if (problems.length || data.warmupFailures.length)
    lines.push(
      "",
      "## Failures",
      "",
      "Failure timings include assertion timeouts and may stop before completing the workflow. They are diagnostic measurements, not normal passing-flow costs. No failures were discarded from the samples or reclassified as skipped tests.",
      "",
      ...problems,
      ...data.warmupFailures.map(
        (item) => `- Warm-up failed in ${item.phase}; see raw logs.`,
      ),
      "",
      ...data.phases.flatMap((phase) =>
        testCases(phase.samples[0] ?? {})
          .filter((item) =>
            ["failed", "flaky", "cancelled"].includes(item.status),
          )
          .map(
            (item) =>
              `- \`${item.file}\`: ${item.names.join(" › ")} (${item.status}).${item.errors?.[0]?.match(/^Locator: (.+)$/m) ? ` Failing locator: \`${item.errors[0].match(/^Locator: (.+)$/m)[1]}\`.` : ""}`,
          ),
      ),
    );
  if (data.inventoryStable === false)
    lines.push(
      "",
      "**Test inventory changed between measured runs. Counts in the tables describe the first round only; this is not a stable baseline.**",
    );
  lines.push(
    "",
    "## Raw data",
    "",
    `Structured measurements: \`${options.output}\`. Raw runner JSON and command logs: \`${data.logs}\` (ignored by Git). The structured snapshot stores each measured run and every test name/duration; keep it with this report for future comparisons.`,
    "",
  );
  return lines.join("\n");
}
