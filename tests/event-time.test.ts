import assert from "node:assert/strict";
import { test } from "vitest";
import { vancouverInput, vancouverInstant } from "../src/data/event-time";

test("event calendar inputs always use Vancouver time", () => {
  assert.equal(
    vancouverInstant("2030-07-02T20:30"),
    "2030-07-03T03:30:00.000Z",
  );
  assert.equal(
    vancouverInstant("2030-01-02T20:30"),
    "2030-01-03T04:30:00.000Z",
  );
  assert.equal(
    vancouverInput(Date.parse("2030-07-03T03:30:00Z")),
    "2030-07-02T20:30",
  );
  assert.throws(
    () => vancouverInstant("2030-02-30T20:30"),
    /skipped or ambiguous/,
  );
  assert.throws(
    () => vancouverInstant("2026-03-08T02:30"),
    /skipped or ambiguous/,
  );
  assert.throws(
    () => vancouverInstant("2026-11-01T01:30"),
    /skipped or ambiguous/,
  );
});

test("event starts allow past Vancouver dates while rejecting invalid wall times", () => {
  assert.equal(
    vancouverInstant("2025-07-02T20:30"),
    "2025-07-03T03:30:00.000Z",
  );
  assert.throws(() => vancouverInstant("2030-02-30T20:30"));
  // Historical DST boundaries are stable across different timezone DB versions.
  for (const input of ["2025-03-09T02:30", "2025-11-02T01:30"])
    assert.throws(() => vancouverInstant(input), /skipped or ambiguous/);
});
