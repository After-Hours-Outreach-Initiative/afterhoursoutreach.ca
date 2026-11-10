import { applicationFields } from "./application";

export type AuditKind = "person" | "event" | "series";

export interface AuditCursor {
  createdAt: number;
  kind: AuditKind;
  id: string;
}

export function auditCursor(value: string | null): AuditCursor | undefined {
  if (!value || value.length > 1000) return;
  try {
    const cursor = JSON.parse(value);
    if (
      Number.isSafeInteger(cursor.createdAt) &&
      cursor.createdAt >= 0 &&
      ["person", "event", "series"].includes(cursor.kind) &&
      typeof cursor.id === "string" &&
      cursor.id.length > 0 &&
      cursor.id.length <= 300
    )
      return { createdAt: cursor.createdAt, kind: cursor.kind, id: cursor.id };
  } catch {
    // A malformed or outdated link starts at the latest history.
  }
}

export function auditLogUrl(cursor?: AuditCursor) {
  return cursor
    ? `/audit-log?before=${encodeURIComponent(JSON.stringify(cursor))}`
    : "/audit-log";
}

const actionLabels: Record<string, string> = {
  profile_viewed: "Viewed profile",
  profile_updated: "Updated profile",
  approval_changed: "Changed approval",
  application_rejected: "Rejected application",
  role_changed: "Changed account role",
  active_changed: "Changed account activity",
  orientation_completed: "Recorded orientation completion",
  signup_joined: "Registered for event",
  signup_cancelled: "Unregistered from event",
  signup_manually_added: "Added event attendee",
  signup_moved: "Moved event attendee",
  signup_removed: "Removed event attendee",
  series_occurrence_created: "Created recurring event",
  updated_future: "Updated future patrols",
  stopped: "Stopped patrol series",
};

export function auditActionLabel(kind: AuditKind, action: string) {
  const subject = kind === "series" ? "patrol series" : "event";
  if (action === "created") return `Created ${subject}`;
  if (action === "updated") return `Updated ${subject}`;
  if (action === "cancelled") return `Cancelled ${subject}`;
  if (action === "deleted") return `Removed ${subject}`;
  return actionLabels[action] ?? humanize(action);
}

const fieldLabels: Record<string, string> = {
  ...Object.fromEntries(
    applicationFields.map(({ name, label }) => [name, label]),
  ),
  startsAt: "Start time",
  includesOrientation: "Includes orientation",
  meetingPoint: "Meeting point",
  meetingPointUrl: "Map link",
  spots: "Capacity",
  minMedicSpots: "Reserved medic places",
  minNewVolunteerSpots: "Reserved new volunteer places",
  maxNewVolunteers: "New volunteer limit",
  unregisterMinutes: "Unregister time",
  open: "Registration open",
  hidden: "Hidden from volunteers",
  cancelledAt: "Cancellation",
  applicationApproved: "Application approval",
  registrationApproved: "Application approval",
  patrolApproved: "Patrol approval",
  orientationCompletion: "Orientation completion",
  naloxoneCompletedAt: "Naloxone course completion",
  active: "Account active",
  role: "Account role",
  localTime: "Local start time",
  firstDate: "First patrol date",
  endDate: "Last patrol date",
  intervalWeeks: "Repeat interval",
  effectiveDate: "Changes effective from",
  stoppedFrom: "Stopped from",
  seriesEndDate: "Last patrol date",
  seriesId: "Patrol series",
  occurrenceDate: "Patrol date",
};

function humanize(value: string) {
  const words = value.replace(/([a-z])([A-Z])/g, "$1 $2").replaceAll("_", " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function auditFieldLabels(json: string | null): string[] {
  if (!json) return [];
  try {
    const fields: unknown = JSON.parse(json);
    if (!Array.isArray(fields)) return [];
    return fields
      .filter(
        (field): field is string =>
          typeof field === "string" && /^[a-z][a-zA-Z0-9_]{0,99}$/.test(field),
      )
      .map((field) => fieldLabels[field] ?? humanize(field));
  } catch {
    return [];
  }
}
