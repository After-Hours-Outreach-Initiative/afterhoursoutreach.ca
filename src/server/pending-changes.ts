import { seriesCadence } from "../data/event-series";
import {
  formatEventDay,
  formatTimeInput,
  vancouverInput,
} from "../data/event-time";

/** One line in a waiting change's list: a setting and what it becomes. */
export interface PendingChange {
  label: string;
  /** Left out when the change is new; "Varies" when the events differ. */
  from?: string;
  to: string;
}

/** Event settings, as the event form names and shows them. */
export interface EventSettings {
  includesOrientation: boolean;
  meetingPoint: string;
  meetingPointUrl: string | null;
  spots: number;
  minMedicSpots: number;
  minNewVolunteerSpots: number;
  maxNewVolunteers: number;
  unregisterMinutes: number;
  visible: boolean;
}

const plural = (count: number, word: string) =>
  `${count} ${count === 1 ? word : `${word}s`}`;
const number = (value: unknown) => String(value);
const settings: [keyof EventSettings, string, (value: never) => string][] = [
  [
    "includesOrientation",
    "Event type",
    (value: boolean) => (value ? "Orientation + Patrol" : "Patrol"),
  ],
  ["meetingPoint", "Meeting point", String],
  ["meetingPointUrl", "Map link", (value: string | null) => value || "None"],
  ["spots", "Volunteer spots", number],
  ["minMedicSpots", "Minimum medic spots", number],
  ["minNewVolunteerSpots", "Minimum new volunteer spots", number],
  ["maxNewVolunteers", "Maximum new volunteers", number],
  [
    "unregisterMinutes",
    "Unregister until",
    (value: number) => `${plural(value, "minute")} after start`,
  ],
  [
    "visible",
    "Public visibility",
    (value: boolean) => (value ? "Visible" : "Hidden"),
  ],
];

/** A line for each value that changes on at least one event. */
function line(
  label: string,
  olds: string[],
  to: string,
): PendingChange | undefined {
  const from = [...new Set(olds)];
  if (from.length === 1 && from[0] === to) return;
  return { label, to, from: from.length === 1 ? from[0] : "Varies" };
}

/** Each setting that changes, from its value on the events to the new one. */
export function settingChanges(
  olds: EventSettings[],
  next: Partial<EventSettings>,
): PendingChange[] {
  return settings.flatMap(([key, label, format]) => {
    if (next[key] === undefined) return [];
    const show = format as (value: unknown) => string;
    const change = line(
      label,
      olds.map((old) => show(old[key])),
      show(next[key]),
    );
    return change ? [change] : [];
  });
}

const clock = (instant: number) =>
  formatTimeInput(vancouverInput(instant).slice(11, 16));
/** "8:30 PM", or "Fri, Nov 14, 8:30 PM" when the day changes too. */
export function startChange(from: number, to: number) {
  if (Math.floor(from / 60_000) === Math.floor(to / 60_000)) return [];
  const sameDay =
    vancouverInput(from).slice(0, 10) === vancouverInput(to).slice(0, 10);
  const show = (instant: number) =>
    sameDay ? clock(instant) : `${formatEventDay(instant)}, ${clock(instant)}`;
  return [
    { label: sameDay ? "Start time" : "Start", from: show(from), to: show(to) },
  ];
}

/** One start time for several events, each on its own date. */
export function startTimeChange(olds: number[], time: string) {
  const change = line("Start time", olds.map(clock), formatTimeInput(time));
  return change ? [change] : [];
}

// Midday UTC is the same calendar date in Vancouver.
const day = (date: string | null) =>
  date ? formatEventDay(Date.parse(`${date}T20:00:00Z`)) : "None";
const offset = (days: number) =>
  days === 0
    ? "Scheduled date"
    : `${plural(Math.abs(days), "day")} ${days > 0 ? "later" : "earlier"}`;

/** Changes to a recurring event's time and schedule. */
export function scheduleChanges(
  old: {
    localTime: string;
    dayOffset?: number;
    intervalWeeks: number;
    endDate: string | null;
  },
  next: {
    localTime?: string;
    dayOffset?: number;
    intervalWeeks?: number;
    endDate?: string | null;
  },
) {
  const changes = [
    next.localTime === undefined
      ? undefined
      : line(
          "Start time",
          [formatTimeInput(old.localTime)],
          formatTimeInput(next.localTime),
        ),
    next.dayOffset === undefined
      ? undefined
      : line("Day", [offset(old.dayOffset ?? 0)], offset(next.dayOffset)),
    next.intervalWeeks === undefined
      ? undefined
      : line(
          "Repeats",
          [seriesCadence(old)!],
          seriesCadence({ intervalWeeks: next.intervalWeeks })!,
        ),
    next.endDate === undefined
      ? undefined
      : line("Last date", [day(old.endDate)], day(next.endDate)),
  ];
  return changes.filter((change) => change !== undefined);
}
