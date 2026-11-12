import { expect, test } from "vitest";
import {
  recurringSaveAction,
  recurringCancelAction,
  eventEmailPrompt,
  seriesScheduleChanged,
} from "../src/scripts/event-recurrence";
const values = (extra: Record<string, string> = {}) => {
  const result = new FormData();
  for (const [key, value] of Object.entries({
    startsAt: "2026-11-03T20:30",
    meetingPoint: "Meeting point",
    meetingPointUrl: "",
    spots: "8",
    minMedicSpots: "2",
    minNewVolunteerSpots: "2",
    maxNewVolunteers: "4",
    unregisterMinutes: "45",
    publicVisibility: "true",
    ...extra,
  }))
    result.set(key, value);
  return result;
};
test("creation keeps Vancouver wall time and inclusive end date with optional orientation on recurring patrols", () => {
  expect(recurringSaveAction(values())).toBeNull();
  expect(
    recurringSaveAction(
      values({ recurring: "on", intervalWeeks: "2", endDate: "2027-01-12" }),
    ),
  ).toEqual({
    action: "save-series",
    series: {
      firstDate: "2026-11-03",
      localTime: "20:30",
      intervalWeeks: 2,
      endDate: "2027-01-12",
      meetingPoint: "Meeting point",
      meetingPointUrl: "",
      spots: 8,
      minMedicSpots: 2,
      minNewVolunteerSpots: 2,
      maxNewVolunteers: 4,
      unregisterMinutes: 45,
      includesOrientation: false,
      open: true,
      hidden: false,
    },
  });
  expect(
    recurringSaveAction(
      values({ includesOrientation: "true", recurring: "on" }),
    ),
  ).toMatchObject({
    action: "save-series",
    series: { includesOrientation: true },
  });
});
test("this-and-future edits use nominal identities and series versions, not occurrence IDs or UTC offsets", () => {
  const data = values({
    seriesId: "series",
    seriesVersion: "8",
    id: "occurrence",
    version: "4",
    occurrenceDate: "2026-11-01",
    scope: "future",
    publicVisibility: "false",
    includesOrientation: "true",
    minMedicSpots: "3",
    minNewVolunteerSpots: "1",
    maxNewVolunteers: "2",
  });
  expect(recurringSaveAction(data)).toMatchObject({
    action: "update-series-from",
    id: "series",
    version: 8,
    occurrenceDate: "2026-11-01",
    scope: "future",
    template: {
      dayOffset: 2,
      localTime: "20:30",
      open: false,
      hidden: true,
      includesOrientation: true,
      minMedicSpots: 3,
      minNewVolunteerSpots: 1,
      maxNewVolunteers: 2,
    },
  });
  expect(recurringCancelAction(data)).toEqual({
    action: "stop-series",
    id: "series",
    version: 8,
    occurrenceDate: "2026-11-01",
    scope: "future",
    reason: "",
  });
  // An empty occurrence must still offer mail for later affected bookings;
  // booked exceptions alone only qualify for series cancellation mail.
  expect(eventEmailPrompt(data, undefined, "series")).toBe("series");
  expect(eventEmailPrompt(data, "event", undefined)).toBeUndefined();
  expect(eventEmailPrompt(data, undefined, "series-cancel")).toBe(
    "series-cancel",
  );
  expect(eventEmailPrompt(data)).toBeUndefined();
  data.set("scope", "occurrence");
  expect(recurringSaveAction(data)).toBeNull();
  expect(recurringCancelAction(data)).toBeNull();
  expect(eventEmailPrompt(data, undefined, "series")).toBeUndefined();
  expect(eventEmailPrompt(data, "event", undefined)).toBe("event");
  expect(eventEmailPrompt(data, "event-cancel", "series-cancel")).toBe(
    "event-cancel",
  );
});
test("all-events edits and cancellations carry their scope, repeat settings and series-wide email prompt", () => {
  const data = values({
    seriesId: "series",
    seriesVersion: "8",
    occurrenceDate: "2026-11-03",
    scope: "all",
    intervalWeeks: "3",
    endDate: "",
  });
  expect(recurringSaveAction(data)).toMatchObject({
    action: "update-series-from",
    scope: "all",
    template: { dayOffset: 0, intervalWeeks: 3, endDate: null },
  });
  expect(recurringCancelAction(data)).toMatchObject({
    action: "stop-series",
    scope: "all",
  });
  expect(eventEmailPrompt(data, "event", "future", "all")).toBe("all");
  data.set("scope", "future");
  expect(eventEmailPrompt(data, "event", "future", "all")).toBe("future");
});

test("series edits send only the fields changed since the form loaded", () => {
  const series = {
    seriesId: "series",
    seriesVersion: "1",
    occurrenceDate: "2026-11-03",
    intervalWeeks: "2",
    endDate: "",
  };
  const saved = values({ ...series, startsAt: "2026-11-02T19:00" });
  const data = values({
    ...series,
    startsAt: "2026-11-02T19:00",
    spots: "10",
    scope: "all",
  });
  expect(recurringSaveAction(data, saved)).toMatchObject({
    action: "update-series-from",
    scope: "all",
    template: { spots: 10 },
  });
  expect(
    Object.keys(
      (recurringSaveAction(data, saved) as { template: object }).template,
    ),
  ).toEqual(["spots"]);
  expect(seriesScheduleChanged(data, saved)).toBe(false);
  data.set("intervalWeeks", "3");
  expect(seriesScheduleChanged(data, saved)).toBe(true);
  expect(recurringSaveAction(data, saved)).toMatchObject({
    template: { spots: 10, intervalWeeks: 3 },
  });
});
