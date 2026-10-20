import { expect, test } from "vitest";
import {
  recurringSaveAction,
  recurringCancelAction,
  seriesEndAction,
} from "../src/scripts/event-recurrence";

const values = (extra: Record<string, string> = {}) => {
  const result = new FormData();
  for (const [key, value] of Object.entries({
    type: "patrol",
    startsAt: "2026-11-03T20:30",
    meetingPoint: "Meeting point",
    meetingPointUrl: "",
    spots: "8",
    publicVisibility: "true",
    ...extra,
  }))
    result.set(key, value);
  return result;
};
test("creation keeps Vancouver wall time and inclusive end date, with recurrence restricted to patrols", () => {
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
      open: true,
      hidden: false,
    },
  });
  expect(
    recurringSaveAction(values({ type: "orientation", recurring: "on" })),
  ).toBeNull();
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
  });
  expect(recurringSaveAction(data)).toMatchObject({
    action: "update-series-from",
    id: "series",
    version: 8,
    occurrenceDate: "2026-11-01",
    template: { dayOffset: 2, localTime: "20:30", open: false, hidden: true },
  });
  expect(recurringCancelAction(data)).toEqual({
    action: "stop-series",
    id: "series",
    version: 8,
    occurrenceDate: "2026-11-01",
    reason: "",
  });
  data.set("scope", "occurrence");
  expect(recurringSaveAction(data)).toBeNull();
  expect(recurringCancelAction(data)).toBeNull();
});
test("end-date updates send only the established series contract and preserve visibility flags", () => {
  const data = values({
    seriesId: "series",
    version: "9",
    endDate: "",
    series: JSON.stringify({
      firstDate: "2026-11-03",
      localTime: "20:30",
      intervalWeeks: 2,
      meetingPoint: "Meeting point",
      meetingPointUrl: null,
      spots: 8,
      open: 0,
      hidden: 0,
      stoppedFrom: "2026-12-01",
      updatedAt: 9,
    }),
  });
  expect(seriesEndAction(data)).toEqual({
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
      open: false,
      hidden: false,
    },
  });
});
