// Node's structured events avoid guessing test counts from source-code patterns.
export default async function* benchmarkReporter(events) {
  const ancestors = new Map();
  const cases = [];
  let summary;

  for await (const { type, data } of events) {
    const file = data.file ?? "";
    if (type === "test:start") {
      const names = ancestors.get(file) ?? [];
      names[data.nesting] = data.name;
      names.length = data.nesting + 1;
      ancestors.set(file, names);
    }
    if (type === "test:pass" || type === "test:fail") {
      cases.push({
        file,
        names: [
          ...(ancestors.get(file) ?? []).slice(0, data.nesting),
          data.name,
        ],
        nesting: data.nesting,
        type: data.details.type,
        durationMs: data.details.duration_ms,
        status: data.skip
          ? "skipped"
          : data.todo
            ? "todo"
            : type === "test:pass"
              ? "passed"
              : "failed",
        ...(data.details.error && {
          error: data.details.error.message,
        }),
      });
    }
    if (type === "test:summary" && !data.file) summary = data;
  }

  yield JSON.stringify({ summary, cases }, null, 2);
}
