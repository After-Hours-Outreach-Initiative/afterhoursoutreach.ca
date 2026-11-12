import assert from "node:assert/strict";
import { test } from "vitest";
import { eventCalendar, type CalendarEvent } from "../src/data/event-calendar";
import { addCalendarDays } from "../src/data/event-time";

const event = (id: string, instant: string): CalendarEvent => ({
  id,
  startsAt: Date.parse(instant),
  label: `Patrol at ${id}`,
});

test("calendar uses Vancouver dates, stable chronological ordering and month boundaries", () => {
  const events = [
    event("later", "2027-01-01T06:30:00Z"),
    event("next-day", "2027-01-01T09:30:00Z"),
    event("earlier", "2027-01-01T02:30:00Z"),
    event("earlier-tie", "2027-01-01T02:30:00Z"),
    event("a-earlier-tie", "2027-01-01T02:30:00Z"),
  ];
  const now = Date.parse("2027-01-01T06:00:00Z");
  const calendar = eventCalendar(events, undefined, now);
  assert.equal(calendar.start, "2026-12-01");
  assert.equal(calendar.range, "Dec 2026");
  const days = calendar.weeks.flat();
  const today = days.find((day) => day.today)!;
  assert.equal(today.date, "2026-12-31");
  assert.deepEqual(
    today.events.map((item) => item.id),
    ["earlier", "earlier-tie", "a-earlier-tie", "later"],
  );
  assert.match(today.events[0].description, /Patrol at earlier/);
  assert.deepEqual(
    days.filter((day) => !day.inMonth).map((day) => day.date),
    ["2026-11-29", "2026-11-30", "2027-01-01", "2027-01-02"],
  );
  assert.equal(
    days.find((day) => day.date === "2027-01-01")!.events[0].id,
    "next-day",
  );
  assert.equal(calendar.next, "2027-01-01");
  const january = eventCalendar(events, calendar.next!, now);
  assert.equal(january.range, "Jan 2027");
  assert.equal(january.previous, "2026-12-01");
  assert.equal(
    january.weeks.flat().find((day) => day.date === "2027-01-01")!.events[0].id,
    "next-day",
  );
  const leading = january.weeks
    .flat()
    .find((day) => day.date === "2026-12-31")!;
  assert.equal(leading.inMonth, false);
  assert.equal(leading.events[0].id, "earlier");
});

for (const [month, count, weeks] of [
  ["2026-02", 28, 4],
  ["2024-02", 29, 5],
  ["2026-08", 31, 6],
  ["2025-03", 31, 6],
  ["2025-11", 30, 6],
] as const) {
  test(`calendar covers every day of ${month} in complete weeks`, () => {
    const calendar = eventCalendar(
      [],
      undefined,
      Date.parse(`${month}-15T12:00:00Z`),
    );
    const days = calendar.weeks.flat();
    const dates = days.filter((day) => day.inMonth);
    assert.equal(calendar.weeks.length, weeks);
    assert.ok(calendar.weeks.every((week) => week.length === 7));
    assert.equal(dates.length, count);
    assert.equal(dates[0].date, `${month}-01`);
    assert.equal(dates.at(-1)!.day, count);
    days.forEach((day, index) =>
      assert.equal(day.date, addCalendarDays(days[0].date, index)),
    );
    assert.equal(calendar.previous, null);
    assert.equal(calendar.next, null);
  });
}

test("navigation advances one month, crosses empty months, and clamps after events disappear", () => {
  const now = Date.parse("2026-10-22T19:00:00Z");
  const events = [event("distant", "2026-12-20T04:00:00Z")];
  const october = eventCalendar(events, undefined, now);
  assert.equal(october.previous, null);
  assert.equal(october.next, "2026-11-01");
  const november = eventCalendar(events, october.next!, now);
  assert.equal(november.previous, "2026-10-01");
  assert.equal(november.next, "2026-12-01");
  const december = eventCalendar(events, november.next!, now);
  assert.ok(december.weeks.flat().some((day) => day.events.length === 1));
  assert.equal(december.next, null);
  assert.equal(eventCalendar(events, "2027-06-01", now).start, december.start);
  const empty = eventCalendar([], december.start, now);
  assert.equal(empty.start, "2026-10-01");
  assert.equal(empty.previous, null);
  assert.equal(empty.next, null);
});

test("calendar marks dates whose events are all cancelled series occurrences", () => {
  const now = Date.parse("2027-01-01T20:00:00Z");
  const cancelled = (id: string, instant: string) => ({
    ...event(id, instant),
    cancelled: true,
  });
  const days = eventCalendar(
    [
      cancelled("cancelled-only", "2027-01-05T03:00:00Z"),
      cancelled("cancelled-first", "2027-01-08T02:00:00Z"),
      event("running", "2027-01-08T04:00:00Z"),
    ],
    undefined,
    now,
  ).weeks.flat();
  const date = (value: string) => days.find((day) => day.date === value)!;
  assert.equal(date("2027-01-04").cancelled, true);
  assert.match(date("2027-01-04").events[0].description, /Cancelled/);
  // A running event on the same date keeps its usual colour and the link.
  assert.equal(date("2027-01-07").cancelled, false);
  assert.deepEqual(
    date("2027-01-07").events.map((item) => item.id),
    ["running", "cancelled-first"],
  );
  assert.equal(date("2027-01-10").cancelled, false);
});
