import assert from "node:assert/strict";
import { test } from "vitest";
import {
  formatEventDate,
  formatTimeInput,
  vancouverInput,
  vancouverInstant,
} from "../src/data/event-time";

test("event and series summaries display AM/PM, including noon, midnight and minutes", () => {
  for (const [canonical, display] of [
    ["00:00", "12:00 AM"],
    ["12:00", "12:00 PM"],
    ["20:31", "8:31 PM"],
  ]) {
    assert.equal(formatTimeInput(canonical), display);
  }
  for (const value of ["24:00", "9:00 PM", "09:60", ""])
    assert.equal(formatTimeInput(value), "");
  assert.match(
    formatEventDate(Date.parse("2030-07-03T03:30:00Z")),
    /8:30\s*p\.?m\.?/i,
  );
});

test("event calendar inputs always use Vancouver time", () => {
  assert.equal(
    vancouverInstant("2030-07-02T20:30"),
    "2030-07-03T03:30:00.000Z",
  );
  assert.equal(
    vancouverInstant("2030-01-02T20:30"),
    "2030-01-03T03:30:00.000Z",
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
    () => vancouverInstant("2025-11-02T01:30"),
    /skipped or ambiguous/,
  );
});

test("Vancouver remains on UTC−7 after the final 2026 spring change", () => {
  assert.equal(
    vancouverInstant("2026-11-01T01:30"),
    "2026-11-01T08:30:00.000Z",
  );
  assert.equal(
    vancouverInput(Date.parse("2026-11-01T09:30:00Z")),
    "2026-11-01T02:30",
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
