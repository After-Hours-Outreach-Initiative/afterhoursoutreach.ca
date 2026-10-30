import assert from "node:assert/strict";
import { test } from "vitest";
import { eventCalendar, type CalendarEvent } from "../src/data/event-calendar";
import { addCalendarDays } from "../src/data/event-time";

const event = (id: string, instant: string): CalendarEvent => ({
  id,
  startsAt: Date.parse(instant),
  label: `Patrol at ${id}`,
});

test("calendar uses Vancouver dates and orders same-day events chronologically with stable ties", () => {
  const events = [
    event("later", "2027-01-01T07:30:00Z"),
    event("next-day", "2027-01-01T08:30:00Z"),
    event("earlier", "2027-01-01T02:30:00Z"),
    event("earlier-tie", "2027-01-01T02:30:00Z"),
    event("a-earlier-tie", "2027-01-01T02:30:00Z"),
  ];
  const calendar = eventCalendar(
    events,
    undefined,
    Date.parse("2027-01-01T07:00:00Z"),
  );
  const days = calendar.weeks.flat();
  assert.equal(calendar.start, "2026-12-27");
  const today = days.find((day) => day.today)!;
  assert.equal(today.date, "2026-12-31");
  assert.deepEqual(
    today.events.map((item) => item.id),
    ["earlier", "earlier-tie", "a-earlier-tie", "later"],
  );
  assert.equal(
    days.find((day) => day.date === "2027-01-01")!.events[0].id,
    "next-day",
  );
  assert.match(today.events[0].description, /Patrol at earlier/);
});

test.each(["2025-03-09T08:00:00Z", "2025-11-02T07:00:00Z"])(
  "calendar has exactly five complete weeks across DST at %s",
  (instant) => {
    const calendar = eventCalendar([], undefined, Date.parse(instant));
    const days = calendar.weeks.flat();
    assert.equal(calendar.weeks.length, 5);
    assert.ok(calendar.weeks.every((week) => week.length === 7));
    assert.equal(new Set(days.map((day) => day.date)).size, 35);
    days.forEach((day, index) =>
      assert.equal(day.date, addCalendarDays(calendar.start, index)),
    );
    assert.equal(calendar.previous, null);
    assert.equal(calendar.next, null);
  },
);

test("calendar navigation reaches distant loaded events and clamps after filtering", () => {
  const now = Date.parse("2026-10-22T19:00:00Z");
  const events = [event("distant", "2026-12-20T04:00:00Z")];
  let calendar = eventCalendar(events, undefined, now);
  assert.equal(calendar.previous, null);
  assert.ok(calendar.next);
  calendar = eventCalendar(events, calendar.next!, now);
  assert.ok(calendar.weeks.flat().some((day) => day.events.length === 1));
  assert.ok(calendar.previous);
  assert.equal(calendar.next, null);
  calendar = eventCalendar([], calendar.start, now);
  assert.equal(calendar.start, "2026-10-18");
  assert.equal(calendar.previous, null);
  assert.equal(calendar.next, null);
});
