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

export interface AuditFilters {
  /** User id of the person who made the change. */
  user?: string;
  /** A `kind:action` key from {@link auditActions}. */
  action?: string;
}

export function auditFilters(params: URLSearchParams): AuditFilters {
  const user = params.get("user");
  const action = params.get("action");
  return {
    user: user && user.length <= 300 ? user : undefined,
    action: action && auditActionsByKey.has(action) ? action : undefined,
  };
}

export function auditLogUrl(filters: AuditFilters = {}, cursor?: AuditCursor) {
  const params = new URLSearchParams();
  if (filters.user) params.set("user", filters.user);
  if (filters.action) params.set("action", filters.action);
  if (cursor) params.set("before", JSON.stringify(cursor));
  const query = params.toString();
  return `/audit-log${query ? `?${query}` : ""}`;
}

export type AuditTone = "create" | "update" | "remove" | "view";

export interface AuditAction {
  kind: AuditKind;
  action: string;
  label: string;
  tone: AuditTone;
  /** Sentence text around the subject, following the actor's name. */
  sentence: [before: string, after: string];
  /** Wording when people changed their own account. */
  selfSentence?: string;
}

const entry = (
  kind: AuditKind,
  action: string,
  label: string,
  tone: AuditTone,
  sentence: string | [string, string],
  selfSentence?: string,
): AuditAction => ({
  kind,
  action,
  label,
  tone,
  sentence: typeof sentence === "string" ? [sentence, ""] : sentence,
  selfSentence,
});

/** Every action the audit tables record, in the order the filter lists them. */
export const auditActions: AuditAction[] = [
  entry(
    "person",
    "profile_viewed",
    "Viewed profile",
    "view",
    "viewed the profile of",
  ),
  entry(
    "person",
    "profile_updated",
    "Updated profile",
    "update",
    "updated the profile of",
    "updated their profile",
  ),
  entry(
    "person",
    "approval_changed",
    "Changed approval",
    "update",
    "changed approval for",
  ),
  entry(
    "person",
    "application_rejected",
    "Rejected application",
    "remove",
    "rejected the application from",
  ),
  entry(
    "person",
    "role_changed",
    "Changed account role",
    "update",
    "changed the account role of",
    "changed their account role",
  ),
  entry(
    "person",
    "active_changed",
    "Changed account activity",
    "update",
    "changed account activity for",
  ),
  entry("event", "created", "Created event", "create", "created"),
  entry(
    "event",
    "series_occurrence_created",
    "Created recurring event",
    "create",
    ["scheduled", "from its patrol series"],
  ),
  entry("event", "updated", "Updated event", "update", "updated"),
  entry(
    "event",
    "series_updated",
    "Updated event from patrol series",
    "update",
    ["updated", "from its patrol series"],
  ),
  entry("event", "cancelled", "Cancelled event", "remove", "cancelled"),
  entry("event", "deleted", "Removed event", "remove", "removed"),
  entry(
    "event",
    "signup_joined",
    "Registered for event",
    "create",
    "registered for",
  ),
  entry(
    "event",
    "signup_cancelled",
    "Unregistered from event",
    "remove",
    "unregistered from",
  ),
  entry(
    "event",
    "signup_manually_added",
    "Added event attendee",
    "create",
    "added attendees to",
  ),
  entry(
    "event",
    "signup_moved",
    "Moved event attendee",
    "update",
    "moved an attendee from",
  ),
  entry(
    "event",
    "signup_removed",
    "Removed event attendee",
    "remove",
    "removed an attendee from",
  ),
  entry("series", "created", "Created patrol series", "create", "created"),
  entry("series", "updated", "Updated patrol series", "update", "updated"),
  entry(
    "series",
    "updated_future",
    "Updated future patrols",
    "update",
    "updated future patrols in",
  ),
  entry("series", "stopped", "Stopped patrol series", "remove", "stopped"),
  entry("series", "deleted", "Removed patrol series", "remove", "removed"),
];

export const auditActionKey = (kind: AuditKind, action: string) =>
  `${kind}:${action}`;

const auditActionsByKey = new Map(
  auditActions.map((item) => [auditActionKey(item.kind, item.action), item]),
);

export function auditAction(kind: AuditKind, action: string): AuditAction {
  return (
    auditActionsByKey.get(auditActionKey(kind, action)) ??
    entry(kind, action, humanize(action), "update", [
      `recorded ${humanize(action).toLowerCase()} for`,
      "",
    ])
  );
}

export const auditActionLabel = (kind: AuditKind, action: string) =>
  auditAction(kind, action).label;

const vancouver = (options: Intl.DateTimeFormatOptions) =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Vancouver",
    ...options,
  });

/** Days since the epoch for the Vancouver calendar date of an instant. */
function vancouverDay(instant: number) {
  const parts = Object.fromEntries(
    vancouver({ year: "numeric", month: "numeric", day: "numeric" })
      .formatToParts(new Date(instant))
      .map(({ type, value }) => [type, Number(value)]),
  );
  return Date.UTC(parts.year, parts.month - 1, parts.day) / 86_400_000;
}

/** Vancouver time relative to today, such as "Yesterday at 2:46 PM". */
export function formatAuditTime(instant: number, now = Date.now()) {
  const date = new Date(instant);
  const days = vancouverDay(now) - vancouverDay(instant);
  const time = vancouver({
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(date);
  if (days === 0) return `Today at ${time}`;
  if (days === 1) return `Yesterday at ${time}`;
  if (days > 1 && days < 7)
    return `Last ${vancouver({ weekday: "long" }).format(date)} at ${time}`;
  const sameYear =
    vancouver({ year: "numeric" }).format(date) ===
    vancouver({ year: "numeric" }).format(new Date(now));
  return `${vancouver({
    month: "short",
    day: "numeric",
    year: sameYear ? undefined : "numeric",
  }).format(date)} at ${time}`;
}

/** Applicants open in application review; approved volunteers in their profile. */
export function auditProfileUrl(
  id: string,
  applicationApproved: boolean,
  returnTo: string,
) {
  return `/${applicationApproved ? "volunteers" : "applications"}/${encodeURIComponent(id)}?returnTo=${encodeURIComponent(returnTo)}`;
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
