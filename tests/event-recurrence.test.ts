import { expect, test } from "vitest";
import {
  recurringSaveAction,
  recurringCancelAction,
  seriesSaveAction,
  eventEmailPrompt,
} from "../src/scripts/event-recurrence";
import { groupManagementEvents } from "../src/data/event-browser";
import type { EventRow, PatrolSeriesRow } from "../src/server/db/events";

test("management groups selected occurrences once per series, retaining one-offs and series without loaded occurrences", () => {
  const event = (id: string, seriesId: string | null) =>
    ({ id, seriesId }) as EventRow;
  const series = ["first", "second", "empty"].map(
    (id) => ({ id }) as PatrolSeriesRow,
  );
  const events = [
    event("selected", "second"),
    event("one-off", null),
    event("next", "first"),
    event("later", "second"),
  ];
  const grouped = groupManagementEvents(events, series);
  expect(grouped).toEqual([
    { kind: "series", series: series[1], events: [events[0], events[3]] },
    { kind: "event", event: events[1] },
    { kind: "series", series: series[0], events: [events[2]] },
    { kind: "series", series: series[2], events: [] },
  ]);
});

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
test("series settings send the create-event fields without a recurring checkbox", () => {
  const data = values({
    seriesId: "series",
    version: "9",
    endDate: "",
    intervalWeeks: "2",
    includesOrientation: "true",
    publicVisibility: "false",
  });
  expect(seriesSaveAction(data)).toEqual({
    action: "save-series",
    id: "series",
    version: 9,
    series: {
      firstDate: "2026-11-03",
      localTime: "20:30",
      intervalWeeks: 2,
      endDate: null,
      meetingPoint: "Meeting point",
      meetingPointUrl: "",
      spots: 8,
      minMedicSpots: 2,
      minNewVolunteerSpots: 2,
      maxNewVolunteers: 4,
      unregisterMinutes: 45,
      open: false,
      hidden: true,
      includesOrientation: true,
    },
  });
});
