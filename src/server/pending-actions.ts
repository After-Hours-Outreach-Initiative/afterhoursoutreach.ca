import type { AuthBindings } from "./auth";
import {
  permissionValues,
  requireOrganizer,
  storedActor,
  writePermission,
  type Actor,
} from "./db/access";
import { databaseErrorMessage, databaseWriteError } from "./db/errors";
import { patrolTemplateLimits } from "./db/patrol-series";
import { profileDisplayNameSql } from "./db/sql";
import { submissionNotificationMode } from "./db/submission-notifications";
import {
  eventActionNotifies,
  eventActionSchema,
  runEventAction,
  type EventActionInput,
} from "./events/actions";
import { actionEmailResult } from "./events/notifications";
import { RequestError } from "./http";
import {
  organizerActionNotifies,
  organizerActionSchema,
  runOrganizerAction,
  type OrganizerActionInput,
} from "./organizer-actions";
import { formatEventDay } from "../data/event-time";

/** How long an action that sends email waits before it is made. */
export const undoDelayMs = 5 * 60_000;
// A run that outlives its lease may or may not have committed.
const leaseMs = 60_000;
// Failures stay visible to their organizer until dismissed, at most this long.
const failureVisibleMs = 24 * 60 * 60_000;
// Finished actions keep their request, which can hold personal notes, this long.
const keepFinishedMs = 30 * 24 * 60 * 60_000;
/** Changes to an event are made, and emailed, this long before it starts. */
const beforeStartMs = 15 * 60_000;
// A shorter wait than this is no chance to undo, so the change is made at once.
const shortestWaitMs = 60_000;

type Endpoint = "events" | "organizer";
type Input = EventActionInput | OrganizerActionInput;
interface Target {
  target: string;
  locked: boolean;
}
interface Hold {
  eventId: string;
  spots: number;
  minMedicSpots: number;
  minNewVolunteerSpots: number;
  maxNewVolunteers: number;
  includesOrientation: boolean;
}
interface EventSummary {
  id: string;
  type: "patrol" | "orientation";
  includesOrientation: number | null;
  startsAt: number;
  updatedAt: number;
  cancelledAt: number | null;
  meetingPoint: string;
  meetingPointUrl: string | null;
  open: number;
  hidden: number;
  unregisterMinutes: number;
  spots: number;
  minMedicSpots: number;
  minNewVolunteerSpots: number;
  maxNewVolunteers: number;
}
export interface PendingActionView {
  id: string;
  endpoint: Endpoint;
  summary: string;
  inlineSummary?: string;
  verb: string;
  runAt: number;
  createdAt: number;
  actorName: string;
  mine: boolean;
  status: "pending" | "running" | "failed";
  message?: string;
  targets: Target[];
}

const busyMessage =
  "Another change here is waiting to be made. Undo it or make it now first.";

/** Items an action changes. Only one waiting action may lock each item. */
function lockedTargets(endpoint: Endpoint, input: Input): string[] {
  if (endpoint === "organizer")
    return "userId" in input ? [`user:${input.userId}`] : [];
  const event = input as EventActionInput;
  switch (event.action) {
    case "save":
    case "cancel-event":
    case "delete-event":
      return event.id ? [`event:${event.id}`] : [];
    case "bulk-save":
      return event.selection.map((row) => `event:${row.id}`);
    case "delete-series":
    case "save-series":
    case "update-series-from":
    case "stop-series":
      return event.id ? [`series:${event.id}`] : [];
    case "manage-signup":
      return [`signup:${event.id}`];
    default:
      return [];
  }
}

/** Whether a roster change would reach anyone: only account registrations get
 * email, and new events and series have nobody to email yet. */
async function hasRecipients(db: Env["DB"], event: EventActionInput) {
  const booked = (where: string, ...values: unknown[]) =>
    db
      .prepare(
        `SELECT 1 FROM event e JOIN signup s ON s.event_id = e.id
        WHERE s.status = 'confirmed' AND s.user_id IS NOT NULL
          AND e.cancelled_at IS NULL AND e.starts_at > ? AND ${where} LIMIT 1`,
      )
      .bind(Date.now(), ...values)
      .first()
      .then(Boolean);
  switch (event.action) {
    case "save":
      return event.id ? booked("e.id = ?", event.id) : false;
    case "cancel-event":
    case "delete-event":
      return booked("e.id = ?", event.id);
    case "bulk-save":
      return booked(
        "e.id IN (SELECT value FROM json_each(?))",
        JSON.stringify(event.selection.map((row) => row.id)),
      );
    case "update-series-from":
    case "stop-series":
      return booked(
        "e.series_id = ? AND e.occurrence_date >= ?",
        event.id,
        event.occurrenceDate,
      );
    case "delete-series":
      return booked("e.series_id = ?", event.id);
    case "save-series":
      // Only shortening a series cancels, and emails, booked occurrences.
      return event.id && event.series.endDate
        ? booked(
            "e.series_id = ? AND e.occurrence_date > ?",
            event.id,
            event.series.endDate,
          )
        : false;
    case "manage-signup":
      return db
        .prepare(
          "SELECT 1 FROM signup WHERE id = ? AND status = 'confirmed' AND user_id IS NOT NULL",
        )
        .bind(event.id)
        .first()
        .then(Boolean);
    default:
      return false;
  }
}

async function wouldEmail(
  bindings: AuthBindings,
  endpoint: Endpoint,
  input: Input,
) {
  if (input.action === "retry-notifications") return false;
  if (endpoint === "events") {
    const event = input as EventActionInput;
    if (!("notify" in event && event.notify)) return false;
    return hasRecipients(bindings.DB, event);
  }
  const organizer = input as OrganizerActionInput;
  if (organizer.action === "reject-application") return true;
  if ("notify" in organizer && organizer.notify) return true;
  // Approving an application also tells the organization inbox.
  if (
    organizer.action !== "status" ||
    !(organizer.applicationApproved ?? organizer.registrationApproved) ||
    submissionNotificationMode(bindings) === "preview"
  )
    return false;
  const status = await bindings.DB.prepare(
    "SELECT registration_approved AS approved FROM volunteer_status WHERE user_id = ?",
  )
    .bind(organizer.userId)
    .first<{ approved: number }>();
  return Boolean(status && !status.approved);
}

async function findEvents(db: Env["DB"], ids: string[]) {
  const rows = await db
    .prepare(
      `SELECT id, type, includes_orientation AS includesOrientation, starts_at AS startsAt,
        updated_at AS updatedAt, cancelled_at AS cancelledAt, spots,
        meeting_point AS meetingPoint, meeting_point_url AS meetingPointUrl, open, hidden,
        unregister_minutes AS unregisterMinutes,
        min_medic_spots AS minMedicSpots, min_new_volunteer_spots AS minNewVolunteerSpots,
        max_new_volunteers AS maxNewVolunteers
      FROM event WHERE id IN (SELECT value FROM json_each(?))`,
    )
    .bind(JSON.stringify(ids))
    .all<EventSummary>();
  return new Map(rows.results.map((row) => [row.id, row]));
}

const hasOrientation = (event: EventSummary) =>
  event.includesOrientation === null
    ? event.type === "orientation"
    : Boolean(event.includesOrientation);
const eventKind = (event: EventSummary | undefined) =>
  event?.type === "orientation" ? "orientation" : "patrol";
const eventName = (event: EventSummary | undefined) =>
  event
    ? `the ${event.type === "orientation" ? "orientation" : "patrol"} on ${formatEventDay(event.startsAt)}`
    : "the event";
// Midday UTC is the same calendar date in Vancouver.
const formatDate = (date: string) =>
  formatEventDay(Date.parse(`${date}T20:00:00Z`));
const earliest = (times: (number | undefined)[]) => {
  const known = times.filter((time) => time !== undefined);
  return known.length ? Math.min(...known) : undefined;
};

const fieldNames: Record<string, string> = {
  startsAt: "start time",
  startTime: "start time",
  meetingPoint: "meeting point",
  meetingPointUrl: "map link",
  spots: "spots",
  minMedicSpots: "medic spots",
  minNewVolunteerSpots: "new volunteer spots",
  maxNewVolunteers: "new volunteer limit",
  unregisterMinutes: "unregister deadline",
  includesOrientation: "orientation setting",
  type: "orientation setting",
  open: "visibility",
  hidden: "visibility",
};
/** "start time and spots", or nothing when there are too many to list. */
function changedFields(keys: string[]) {
  const names = [...new Set(keys.map((key) => fieldNames[key]))].filter(
    Boolean,
  );
  if (!names.length || names.length > 3) return undefined;
  return names.length === 1
    ? names[0]
    : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}
function savedFields(
  old: EventSummary,
  next: Extract<EventActionInput, { action: "save" }>["event"],
) {
  const changed: Record<string, boolean> = {
    // The form keeps minutes only.
    startsAt:
      Math.floor(Date.parse(next.startsAt) / 60_000) !==
      Math.floor(old.startsAt / 60_000),
    meetingPoint: next.meetingPoint !== old.meetingPoint,
    meetingPointUrl: next.meetingPointUrl !== (old.meetingPointUrl ?? ""),
    spots: next.spots !== old.spots,
    minMedicSpots:
      next.minMedicSpots !== undefined &&
      next.minMedicSpots !== old.minMedicSpots,
    minNewVolunteerSpots:
      next.minNewVolunteerSpots !== undefined &&
      next.minNewVolunteerSpots !== old.minNewVolunteerSpots,
    maxNewVolunteers:
      next.maxNewVolunteers !== undefined &&
      next.maxNewVolunteers !== old.maxNewVolunteers,
    unregisterMinutes:
      next.unregisterMinutes !== undefined &&
      next.unregisterMinutes !== old.unregisterMinutes,
    includesOrientation:
      (next.includesOrientation ??
        (next.type ? next.type === "orientation" : hasOrientation(old))) !==
      hasOrientation(old),
    open:
      next.open !== Boolean(old.open) || next.hidden !== Boolean(old.hidden),
  };
  return changedFields(Object.keys(changed).filter((key) => changed[key]));
}

/** Upcoming occurrences of a series that a change reaches. */
async function occurrences(
  db: Env["DB"],
  seriesId: string,
  where = "1",
  ...values: unknown[]
) {
  const rows = await db
    .prepare(
      `SELECT id, starts_at AS startsAt FROM event WHERE series_id = ?
        AND cancelled_at IS NULL AND starts_at > ? AND ${where}`,
    )
    .bind(seriesId, Date.now(), ...values)
    .all<{ id: string; startsAt: number }>();
  return {
    ids: rows.results.map((row) => row.id),
    targets: rows.results.map((row) => ({
      target: `event:${row.id}`,
      locked: true,
    })),
    startsAt: earliest(rows.results.map((row) => row.startsAt)),
  };
}

async function personName(db: Env["DB"], userId: string) {
  const row = await db
    .prepare(
      `SELECT ${profileDisplayNameSql} AS name FROM user u
      LEFT JOIN profile p ON p.user_id = u.id WHERE u.id = ?`,
    )
    .bind(userId)
    .first<{ name: string | null }>();
  return row?.name || "this volunteer";
}

function eventHold(
  event: EventSummary,
  changes: {
    spots?: number;
    minMedicSpots?: number;
    minNewVolunteerSpots?: number;
    maxNewVolunteers?: number;
    includesOrientation?: boolean;
    type?: "patrol" | "orientation";
  },
): Hold {
  return {
    eventId: event.id,
    spots: changes.spots ?? event.spots,
    minMedicSpots: changes.minMedicSpots ?? event.minMedicSpots,
    minNewVolunteerSpots:
      changes.minNewVolunteerSpots ?? event.minNewVolunteerSpots,
    maxNewVolunteers: changes.maxNewVolunteers ?? event.maxNewVolunteers,
    includesOrientation:
      changes.includesOrientation ??
      (changes.type ? changes.type === "orientation" : hasOrientation(event)),
  };
}

function requireCurrent(event: EventSummary | undefined, version: number) {
  if (!event) return;
  if (event.cancelledAt)
    throw new RequestError(409, "Cancelled events cannot be edited.");
  if (event.updatedAt !== version)
    throw new RequestError(
      409,
      "This event changed. Reload before editing it.",
    );
}

/** What the timer shows, what it locks, and the limits it holds. */
async function describe(
  db: Env["DB"],
  actor: Actor,
  endpoint: Endpoint,
  input: Input,
): Promise<{
  summary: string;
  /** Shorter wording shown on the item itself, which needs no name or date. */
  inline?: string;
  verb: string;
  targets: Target[];
  holds: Hold[];
  /** When the soonest event it changes starts. */
  startsAt?: number;
}> {
  const targets = lockedTargets(endpoint, input).map((target) => ({
    target,
    locked: true,
  }));
  const holds: Hold[] = [];
  if (endpoint === "organizer") {
    const organizer = input as Exclude<
      OrganizerActionInput,
      { action: "retry-notifications" }
    >;
    const name = await personName(db, organizer.userId);
    // A stale or impossible decision fails now, not when the timer ends.
    if ("version" in organizer) {
      const current = await db
        .prepare(
          `SELECT updated_at AS version, registration_approved AS approved,
            application_rejection_reason IS NOT NULL AS rejected
          FROM volunteer_status WHERE user_id = ?`,
        )
        .bind(organizer.userId)
        .first<{ version: number; approved: number; rejected: number }>();
      if (current && current.version !== organizer.version)
        throw new RequestError(
          409,
          "This volunteer's status changed. Reload before saving.",
        );
      if (
        current &&
        organizer.action === "reject-application" &&
        (current.approved || current.rejected)
      )
        throw new RequestError(
          409,
          "The application or organizer access changed. Reload before reviewing.",
        );
    }
    if (organizer.action === "reject-application")
      return {
        summary: `Rejecting ${name}'s application`,
        verb: "Reject",
        targets,
        holds,
      };
    if (organizer.action === "approve-patrols")
      return {
        summary: `Approving ${name} for patrols`,
        verb: "Approve",
        targets,
        holds,
      };
    if (organizer.action === "role")
      return {
        summary: `Making ${name} ${organizer.role === "organizer" ? "an organizer" : "a volunteer"}`,
        verb: "Change",
        targets,
        holds,
      };
    const old = await db
      .prepare(
        `SELECT active, registration_approved AS applicationApproved, patrol_approved AS patrolApproved
        FROM volunteer_status WHERE user_id = ?`,
      )
      .bind(organizer.userId)
      .first<{
        active: number;
        applicationApproved: number;
        patrolApproved: number;
      }>();
    const applicationApproved =
      organizer.applicationApproved ?? organizer.registrationApproved;
    const [summary, verb] =
      old && Boolean(old.active) !== organizer.active
        ? organizer.active
          ? [`Reactivating ${name}`, "Reactivate"]
          : [`Deactivating ${name}`, "Deactivate"]
        : old &&
            applicationApproved !== undefined &&
            Boolean(old.applicationApproved) !== applicationApproved
          ? applicationApproved
            ? [`Approving ${name}'s application`, "Approve"]
            : [`Revoking ${name}'s application approval`, "Revoke"]
          : old && Boolean(old.patrolApproved) !== organizer.patrolApproved
            ? organizer.patrolApproved
              ? [`Approving ${name} for patrols`, "Approve"]
              : [`Revoking ${name}'s patrol approval`, "Revoke"]
            : [`Updating ${name}'s access`, "Save"];
    return { summary, verb, targets, holds };
  }
  const event = input as EventActionInput;
  switch (event.action) {
    case "save": {
      const old = (await findEvents(db, [event.id!])).get(event.id!);
      requireCurrent(old, event.version ?? -1);
      if (old) holds.push(eventHold(old, event.event));
      const fields = old && savedFields(old, event.event);
      return {
        summary: fields
          ? `Changing the ${fields} of ${eventName(old)}`
          : `Saving changes to ${eventName(old)}`,
        inline: fields ? `Changing the ${fields}` : "Saving changes",
        verb: "Save",
        targets,
        holds,
        startsAt: earliest([old?.startsAt, Date.parse(event.event.startsAt)]),
      };
    }
    case "cancel-event":
    case "delete-event": {
      const old = (await findEvents(db, [event.id])).get(event.id);
      requireCurrent(old, event.version);
      return event.action === "cancel-event"
        ? {
            summary: `Cancelling ${eventName(old)}`,
            inline: `Cancelling this ${eventKind(old)}`,
            // Names what it cancels, so it never reads as undoing the wait.
            verb: "Cancel event",
            targets,
            holds,
            startsAt: old?.startsAt,
          }
        : {
            summary: `Deleting ${eventName(old)}`,
            inline: `Deleting this ${eventKind(old)}`,
            verb: "Delete",
            targets,
            holds,
            startsAt: old?.startsAt,
          };
    }
    case "bulk-save": {
      const events = await findEvents(
        db,
        event.selection.map((row) => row.id),
      );
      for (const row of event.selection) {
        const old = events.get(row.id);
        requireCurrent(old, row.version);
        if (old) holds.push(eventHold(old, event.changes));
      }
      const count = event.selection.length;
      const fields = changedFields(
        Object.entries(event.changes)
          .filter(([, value]) => value !== undefined)
          .map(([key]) => key),
      );
      const what = fields ? `Changing the ${fields} of` : "Saving changes to";
      return {
        summary:
          count === 1
            ? `${what} ${eventName(events.get(event.selection[0].id))}`
            : `${what} ${count} events`,
        // Undo reverts every selected event, so each card says how many.
        inline:
          count === 1
            ? fields
              ? `Changing the ${fields}`
              : "Saving changes"
            : `${what} ${count} events`,
        verb: "Save",
        targets,
        holds,
        startsAt: earliest([...events.values()].map((old) => old.startsAt)),
      };
    }
    case "update-series-from": {
      const limits = await patrolTemplateLimits(
        db,
        actor,
        event.id,
        event.occurrenceDate,
        event.template,
      );
      const reached = await occurrences(
        db,
        event.id,
        "occurrence_date >= ?",
        event.occurrenceDate,
      );
      if (limits) {
        const events = await findEvents(db, reached.ids);
        for (const old of events.values()) holds.push(eventHold(old, limits));
      }
      return {
        summary: `Saving patrol series changes from ${formatDate(event.occurrenceDate)}`,
        inline: `Saving changes from ${formatDate(event.occurrenceDate)}`,
        verb: "Save",
        targets: [...targets, ...reached.targets],
        holds,
        startsAt: reached.startsAt,
      };
    }
    case "save-series": {
      // Only shortening a series reaches its occurrences.
      const reached =
        event.id && event.series.endDate
          ? await occurrences(
              db,
              event.id,
              "occurrence_date > ?",
              event.series.endDate,
            )
          : undefined;
      return {
        summary: "Saving the patrol series",
        inline: "Saving changes",
        verb: "Save",
        targets: [...targets, ...(reached?.targets ?? [])],
        holds,
        startsAt: reached?.startsAt,
      };
    }
    case "stop-series": {
      const reached = await occurrences(
        db,
        event.id,
        "occurrence_date >= ?",
        event.occurrenceDate,
      );
      return {
        summary: `Ending the patrol series from ${formatDate(event.occurrenceDate)}`,
        inline: `Ending this series from ${formatDate(event.occurrenceDate)}`,
        verb: "End",
        targets: [...targets, ...reached.targets],
        holds,
        startsAt: reached.startsAt,
      };
    }
    case "delete-series": {
      const reached = await occurrences(db, event.id);
      return {
        summary: "Deleting the patrol series",
        inline: "Deleting this series",
        verb: "Delete",
        targets: [...targets, ...reached.targets],
        holds,
        startsAt: reached.startsAt,
      };
    }
    case "manage-signup": {
      const signup = await db
        .prepare(
          `SELECT s.event_id AS eventId, coalesce(s.manual_name, ${profileDisplayNameSql}) AS name
          FROM signup s LEFT JOIN user u ON u.id = s.user_id
          LEFT JOIN profile p ON p.user_id = s.user_id WHERE s.id = ?`,
        )
        .bind(event.id)
        .first<{ eventId: string; name: string | null }>();
      if (!signup) throw new RequestError(404, "Registration not found.");
      // Show the change on the event without blocking its other changes.
      targets.push({ target: `event:${signup.eventId}`, locked: false });
      const events = await findEvents(
        db,
        [signup.eventId, event.destination].filter(Boolean) as string[],
      );
      const name = signup.name || "this volunteer";
      const startsAt = earliest(
        [...events.values()].map((found) => found.startsAt),
      );
      return event.destination
        ? {
            summary: `Moving ${name} to ${eventName(events.get(event.destination))}`,
            verb: "Move",
            targets,
            holds,
            startsAt,
          }
        : {
            summary: `Removing ${name} from ${eventName(events.get(signup.eventId))}`,
            inline: `Removing ${name}`,
            verb: "Remove",
            targets,
            holds,
            startsAt,
          };
    }
    default:
      throw new Error("This action does not wait.");
  }
}

/** Refuse a change to an item whose earlier change is still waiting. */
export async function assertUnlocked(
  db: Env["DB"],
  endpoint: Endpoint,
  input: Input,
) {
  const targets = lockedTargets(endpoint, input);
  if (!targets.length) return;
  await throwIfBusy(db, targets);
}

/** Name the waiting change in the error, so the page can offer it. */
async function throwIfBusy(db: Env["DB"], targets: string[]) {
  const busy = await db
    .prepare(
      `SELECT a.id FROM pending_action_target t JOIN pending_action a ON a.id = t.action_id
      WHERE t.locked = 1 AND a.status IN ('pending','running')
        AND t.target IN (SELECT value FROM json_each(?)) LIMIT 1`,
    )
    .bind(JSON.stringify(targets))
    .first<string>("id");
  if (busy) throw new RequestError(409, busyMessage, { pendingActionId: busy });
}

class ReachedWrite extends Error {}
const writeSql = /^\s*(insert|update|delete|replace)\b/i;

/** The database as an action sees it, until the action first tries to write. */
function readOnly(db: Env["DB"]): Env["DB"] {
  const stop = () => {
    throw new ReachedWrite();
  };
  const statement = (prepared: D1PreparedStatement): D1PreparedStatement =>
    new Proxy(prepared, {
      get(target, property) {
        if (property === "bind")
          return (...values: unknown[]) => statement(target.bind(...values));
        if (["run", "first", "all", "raw"].includes(String(property)))
          return async () => stop();
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  return new Proxy(db, {
    get(target, property) {
      if (property === "batch" || property === "exec")
        return async () => stop();
      if (property === "prepare")
        return (sql: string) =>
          writeSql.test(sql)
            ? statement(target.prepare(sql))
            : target.prepare(sql);
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/** Run the action's own checks now, so a change that cannot be made fails
 * straight away with the usual message instead of when its timer ends. */
async function validate(
  bindings: AuthBindings,
  actor: Actor,
  endpoint: Endpoint,
  input: Input,
) {
  const db = readOnly(bindings.DB);
  try {
    if (endpoint === "events")
      await runEventAction(db, actor, input as EventActionInput);
    else
      await runOrganizerAction(
        { ...bindings, DB: db },
        actor,
        input as OrganizerActionInput,
      );
  } catch (error) {
    if (!(error instanceof ReachedWrite)) throw error;
  }
}

/** Store an action that sends email instead of making it. Returns null for
 * actions that run straight away. */
export async function schedulePendingAction(
  bindings: AuthBindings,
  actor: Actor,
  endpoint: Endpoint,
  input: Input,
) {
  if (!(await wouldEmail(bindings, endpoint, input))) return null;
  requireOrganizer(actor);
  const db = bindings.DB;
  await validate(bindings, actor, endpoint, input);
  const plan = await describe(db, actor, endpoint, input);
  const id = crypto.randomUUID();
  const now = Date.now();
  // Volunteers hear about a change to an event before it starts.
  const runAt = Math.min(
    now + undoDelayMs,
    (plan.startsAt ?? Infinity) - beforeStartMs,
  );
  if (runAt - now < shortestWaitMs) return null;
  const exists = "EXISTS(SELECT 1 FROM pending_action WHERE id = ?)";
  try {
    const results = await db.batch([
      db
        .prepare(
          `INSERT INTO pending_action (id, endpoint, input, actor_id, session_id, origin, summary, inline_summary, verb, run_at, created_at)
          SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${writePermission(true)}`,
        )
        .bind(
          id,
          endpoint,
          JSON.stringify(input),
          actor.id,
          actor.sessionId,
          bindings.AUTH_BASE_URL,
          plan.summary,
          plan.inline ?? null,
          plan.verb,
          runAt,
          now,
          ...permissionValues(actor),
        ),
      ...plan.targets.map(({ target, locked }) =>
        db
          .prepare(
            `INSERT INTO pending_action_target (action_id, target, locked) SELECT ?, ?, ? WHERE ${exists}`,
          )
          .bind(id, target, Number(locked), id),
      ),
      ...plan.holds.map((hold) =>
        db
          .prepare(
            `INSERT INTO event_capacity_hold (action_id, event_id, spots, min_medic_spots,
              min_new_volunteer_spots, max_new_volunteers, includes_orientation)
            SELECT ?, ?, ?, ?, ?, ?, ? WHERE ${exists}`,
          )
          .bind(
            id,
            hold.eventId,
            hold.spots,
            hold.minMedicSpots,
            hold.minNewVolunteerSpots,
            hold.maxNewVolunteers,
            Number(hold.includesOrientation),
            id,
          ),
      ),
    ]);
    if (!results[0].meta.changes)
      throw new RequestError(
        403,
        "Organizer authorization changed. Sign in again.",
      );
  } catch (error) {
    if (
      databaseErrorMessage(error).includes(
        "UNIQUE constraint failed: pending_action_target",
      )
    ) {
      await throwIfBusy(
        db,
        plan.targets.filter((t) => t.locked).map((t) => t.target),
      );
      throw new RequestError(409, busyMessage);
    }
    databaseWriteError(error);
  }
  const action: PendingActionView = {
    id,
    endpoint,
    summary: plan.summary,
    ...(plan.inline ? { inlineSummary: plan.inline } : {}),
    verb: plan.verb,
    runAt,
    createdAt: now,
    actorName: actor.name,
    mine: true,
    status: "pending",
    targets: plan.targets,
  };
  return { action, message: `${plan.summary}.` };
}

function releaseStatements(db: Env["DB"], id: string) {
  return [
    db
      .prepare("DELETE FROM pending_action_target WHERE action_id = ?")
      .bind(id),
    db.prepare("DELETE FROM event_capacity_hold WHERE action_id = ?").bind(id),
  ];
}

async function failStaleRuns(db: Env["DB"]) {
  const now = Date.now();
  const stale = await db
    .prepare(
      `UPDATE pending_action SET status = 'failed', finished_at = ?, lease_until = NULL,
        message = 'This change could not be confirmed. Check it before making it again.'
      WHERE status = 'running' AND lease_until < ? RETURNING id`,
    )
    .bind(now, now)
    .all<{ id: string }>();
  if (stale.results.length)
    await db.batch(
      stale.results.flatMap(({ id }) => releaseStatements(db, id)),
    );
}

/** The author, through a live session or, once they have signed out, a
 * session that lasts only for this run. Writes still check that they are an
 * active organizer. */
async function authorActor(
  bindings: AuthBindings,
  userId: string,
  sessionId: string,
) {
  const live = await storedActor(bindings, userId, sessionId);
  if (live) return { actor: live, end: async () => {} };
  const db = bindings.DB;
  const id = crypto.randomUUID();
  const now = Date.now();
  await db
    .prepare(
      `INSERT INTO session (id, user_id, token, expires_at, created_at, updated_at, two_factor_verified)
      SELECT ?, id, ?, ?, ?, ?, 1 FROM user WHERE id = ? AND deleted_at IS NULL`,
    )
    .bind(id, crypto.randomUUID(), now + leaseMs, now, now, userId)
    .run();
  const end = async () => {
    await db.prepare("DELETE FROM session WHERE id = ?").bind(id).run();
  };
  return { actor: await storedActor(bindings, userId, id), end };
}

/** Make a waiting action once. `runner` makes it early, as that organizer if
 * its author's account is gone. */
export async function runPendingAction(
  bindings: AuthBindings,
  id: string,
  runner?: Actor,
) {
  const db = bindings.DB;
  const now = Date.now();
  if (runner) requireOrganizer(runner);
  const claimed = await db
    .prepare(
      `UPDATE pending_action SET status = 'running', lease_until = ?
      WHERE id = ? AND status = 'pending' AND (run_at <= ? OR ?)
      RETURNING endpoint, input, actor_id AS actorId, session_id AS sessionId, origin`,
    )
    .bind(now + leaseMs, id, now, Number(Boolean(runner)))
    .first<{
      endpoint: Endpoint;
      input: string;
      actorId: string;
      sessionId: string;
      origin: string;
    }>();
  if (!claimed) return null;
  const scoped = { ...bindings, AUTH_BASE_URL: claimed.origin };
  let status: "done" | "failed" = "failed";
  let delivery: Awaited<ReturnType<typeof actionEmailResult>> | undefined;
  let message: string;
  const author = await authorActor(
    bindings,
    claimed.actorId,
    claimed.sessionId,
  );
  try {
    const actor = author.actor ?? runner;
    if (!actor)
      throw new RequestError(
        403,
        "This change was not made because the account that made it was removed.",
      );
    const raw: unknown = JSON.parse(claimed.input);
    if (claimed.endpoint === "events") {
      const input = eventActionSchema.parse(raw);
      const result = await runEventAction(db, actor, input);
      delivery = await actionEmailResult(
        scoped,
        result,
        eventActionNotifies(input),
      );
    } else {
      const input = organizerActionSchema.parse(raw);
      const result = await runOrganizerAction(scoped, actor, input);
      delivery = await actionEmailResult(
        scoped,
        result,
        organizerActionNotifies(input, result),
      );
    }
    status = "done";
    message = delivery.message;
  } catch (error) {
    message =
      error instanceof RequestError
        ? error.message
        : "This change could not be made. Try making it again.";
  } finally {
    await author.end();
  }
  await db.batch([
    db
      .prepare(
        `UPDATE pending_action SET status = ?, message = ?, finished_at = ?, finished_by = ?, lease_until = NULL
        WHERE id = ? AND status = 'running'`,
      )
      .bind(status, message, Date.now(), runner?.id ?? null, id),
    ...releaseStatements(db, id),
  ]);
  return { status, message, delivery };
}

/** Make every action whose timer has ended. Runs from the minute cron and
 * when organizers load the list, so local development needs no scheduler. */
export async function runDuePendingActions(bindings: AuthBindings) {
  const db = bindings.DB;
  await failStaleRuns(db);
  const finished = `SELECT id FROM pending_action
    WHERE status IN ('done','undone','failed') AND finished_at < ?`;
  const before = Date.now() - keepFinishedMs;
  await db.batch(
    ["pending_action_target", "event_capacity_hold"]
      .map((table) =>
        db
          .prepare(`DELETE FROM ${table} WHERE action_id IN (${finished})`)
          .bind(before),
      )
      .concat(
        db
          .prepare(`DELETE FROM pending_action WHERE id IN (${finished})`)
          .bind(before),
      ),
  );
  const due = await db
    .prepare(
      `SELECT id FROM pending_action WHERE status = 'pending' AND run_at <= ?
      ORDER BY run_at LIMIT 20`,
    )
    .bind(Date.now())
    .all<{ id: string }>();
  for (const { id } of due.results) await runPendingAction(bindings, id);
}

export async function undoPendingAction(
  db: Env["DB"],
  actor: Actor,
  id: string,
) {
  requireOrganizer(actor);
  const results = await db.batch([
    db
      .prepare(
        `UPDATE pending_action SET status = 'undone', finished_at = ?, finished_by = ?
        WHERE id = ? AND status = 'pending' AND ${writePermission(true)}`,
      )
      .bind(Date.now(), actor.id, id, ...permissionValues(actor)),
    ...["pending_action_target", "event_capacity_hold"].map((table) =>
      db
        .prepare(
          `DELETE FROM ${table} WHERE action_id = ?
          AND EXISTS(SELECT 1 FROM pending_action WHERE id = ? AND status = 'undone')`,
        )
        .bind(id, id),
    ),
  ]);
  if (!results[0].meta.changes)
    throw new RequestError(409, "This change was already made.");
}

export async function dismissPendingAction(
  db: Env["DB"],
  actor: Actor,
  id: string,
) {
  requireOrganizer(actor);
  await db
    .prepare(
      `UPDATE pending_action SET dismissed_at = ?
      WHERE id = ? AND actor_id = ? AND status = 'failed'`,
    )
    .bind(Date.now(), id, actor.id)
    .run();
}

/** Waiting actions for every organizer, and this organizer's unseen failures. */
export async function listPendingActions(
  db: Env["DB"],
  actor: Actor,
): Promise<PendingActionView[]> {
  requireOrganizer(actor);
  const rows = await db
    .prepare(
      `SELECT a.id, a.endpoint, a.summary, a.inline_summary AS inlineSummary, a.verb,
        a.run_at AS runAt, a.created_at AS createdAt, a.status, a.message,
        a.actor_id AS actorId, ${profileDisplayNameSql} AS actorName,
        (SELECT json_group_array(json_object('target', t.target, 'locked', t.locked))
          FROM pending_action_target t WHERE t.action_id = a.id) AS targets
      FROM pending_action a JOIN user u ON u.id = a.actor_id
      LEFT JOIN profile p ON p.user_id = a.actor_id
      WHERE a.status IN ('pending','running')
        OR (a.status = 'failed' AND a.actor_id = ? AND a.dismissed_at IS NULL AND a.finished_at > ?)
      ORDER BY a.created_at DESC LIMIT 100`,
    )
    .bind(actor.id, Date.now() - failureVisibleMs)
    .all<{
      id: string;
      endpoint: Endpoint;
      summary: string;
      inlineSummary: string | null;
      verb: string;
      runAt: number;
      createdAt: number;
      status: PendingActionView["status"];
      message: string | null;
      actorId: string;
      actorName: string | null;
      targets: string;
    }>();
  return rows.results.map((row) => ({
    id: row.id,
    endpoint: row.endpoint,
    summary: row.summary,
    ...(row.inlineSummary ? { inlineSummary: row.inlineSummary } : {}),
    verb: row.verb,
    runAt: row.runAt,
    createdAt: row.createdAt,
    status: row.status,
    ...(row.message ? { message: row.message } : {}),
    actorName: row.actorName || "An organizer",
    mine: row.actorId === actor.id,
    targets: (
      JSON.parse(row.targets) as { target: string; locked: number }[]
    ).map(({ target, locked }) => ({ target, locked: Boolean(locked) })),
  }));
}
