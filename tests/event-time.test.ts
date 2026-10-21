import assert from "node:assert/strict";
import { test } from "vitest";
import {
  futureEventInstant,
  vancouverInput,
  vancouverInstant,
} from "../src/data/event-time";

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

test("event starts must be strictly in the future in Vancouver time", () => {
  // Vancouver is still on July 2 even though the UTC date is already July 3.
  const now = Date.parse("2030-07-03T03:30:00Z");
  for (const input of [
    "2030-07-01T20:30",
    "2030-07-02T20:29",
    "2030-07-02T20:30",
  ])
    assert.throws(
      () => futureEventInstant(input, now),
      /future start date and time/,
    );
  assert.equal(
    futureEventInstant("2030-07-02T20:31", now),
    "2030-07-03T03:31:00.000Z",
  );
  assert.throws(
    () => futureEventInstant("2030-07-02T20:31", now + 60_000),
    /future start date and time/,
  );
  assert.throws(() => futureEventInstant("2030-02-30T20:30", now));
  // Historical DST boundaries are stable across different timezone DB versions.
  const beforeDstChanges = Date.parse("2025-01-01T00:00:00Z");
  for (const input of ["2025-03-09T02:30", "2025-11-02T01:30"])
    assert.throws(
      () => futureEventInstant(input, beforeDstChanges),
      /skipped or ambiguous/,
    );
});
