import assert from "node:assert/strict";
import { test } from "vitest";
import { vancouverInstant } from "../src/data/event-time";
import {
  scheduleChanges,
  settingChanges,
  startChange,
  startTimeChange,
  type EventSettings,
} from "../src/server/pending-changes";

const settings: EventSettings = {
  includesOrientation: false,
  meetingPoint: "Point",
  meetingPointUrl: null,
  spots: 8,
  minMedicSpots: 1,
  minNewVolunteerSpots: 0,
  maxNewVolunteers: 2,
  unregisterMinutes: 30,
  visible: true,
};
const at = (input: string) => Date.parse(vancouverInstant(input));

test("each changed setting is listed from and to, and unchanged ones are left out", () => {
  assert.deepEqual(
    settingChanges([settings], {
      ...settings,
      includesOrientation: true,
      meetingPointUrl: "",
      spots: 10,
      unregisterMinutes: 1,
      visible: false,
    }),
    [
      { label: "Event type", from: "Patrol", to: "Orientation + Patrol" },
      { label: "Volunteer spots", from: "8", to: "10" },
      {
        label: "Unregister until",
        from: "30 minutes after start",
        to: "1 minute after start",
      },
      { label: "Public visibility", from: "Visible", to: "Hidden" },
    ],
  );
});

test("several events show a shared old value, or that it varies", () => {
  assert.deepEqual(
    settingChanges([settings, { ...settings, spots: 6 }], {
      spots: 10,
      minMedicSpots: 2,
    }),
    [
      { label: "Volunteer spots", from: "Varies", to: "10" },
      { label: "Minimum medic spots", from: "1", to: "2" },
    ],
  );
  assert.deepEqual(
    startTimeChange([at("2026-11-17T18:00"), at("2026-11-24T18:00")], "18:30"),
    [{ label: "Start time", from: "6:00 PM", to: "6:30 PM" }],
  );
  assert.deepEqual(startTimeChange([at("2026-11-17T18:00")], "18:00"), []);
});

test("a start on the same day shows the time; another day shows the date too", () => {
  assert.deepEqual(
    startChange(at("2026-11-17T18:00"), at("2026-11-17T18:30")),
    [{ label: "Start time", from: "6:00 PM", to: "6:30 PM" }],
  );
  assert.deepEqual(
    startChange(at("2026-11-17T18:00"), at("2026-11-18T18:00")),
    [
      {
        label: "Start",
        from: "Tue, Nov 17, 6:00 PM",
        to: "Wed, Nov 18, 6:00 PM",
      },
    ],
  );
  assert.deepEqual(
    startChange(at("2026-11-17T18:00"), at("2026-11-17T18:00")),
    [],
  );
});

test("recurring schedule changes name the cadence and last date", () => {
  assert.deepEqual(
    scheduleChanges(
      { localTime: "18:00", intervalWeeks: 2, endDate: null },
      {
        localTime: "18:00",
        dayOffset: 1,
        intervalWeeks: 1,
        endDate: "2026-12-15",
      },
    ),
    [
      { label: "Day", from: "Scheduled date", to: "1 day later" },
      { label: "Repeats", from: "Every 2 weeks", to: "Every week" },
      { label: "Last date", from: "None", to: "Tue, Dec 15" },
    ],
  );
});
