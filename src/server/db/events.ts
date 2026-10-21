import { z } from "zod";
import {
  publicAttendeeName,
  type AttendeeCategory,
} from "../../data/event-roster";
import type { Actor } from "./access";
import {
  requireOrganizer,
  requireVolunteer,
  canViewEvents,
  writePermission,
  permissionValues,
} from "./access";
import { RequestError } from "../http";
import {
  approvedMedicSql,
  includesOrientationSql,
  nowMsSql,
  profileDisplayNameSql,
} from "./sql";
import {
  availableSignupSpots,
  orientationCapacityMessage,
  validOrientationCapacity,
} from "./policy";
import { databaseWriteError } from "./errors";
import {
  ensurePatrolOccurrences,
  recurringSignupWindowSql,
} from "./patrol-series";

export {
  patrolSeriesSchema,
  savePatrolSeries,
  listPatrolSeries,
  findPatrolSeries,
  ensurePatrolOccurrences,
  materializePatrolOccurrence,
  patrolOccurrenceId,
  patrolTemplateSchema,
  listPatrolTemplates,
  patrolTemplateFor,
  updatePatrolSeriesFrom,
  stopPatrolSeries,
  type PatrolSeriesRow,
} from "./patrol-series";

export const eventSchema = z
  .strictObject({
    // Accept old clients during rollout; includesOrientation is the public model.
    type: z.enum(["patrol", "orientation"]).optional(),
    includesOrientation: z.boolean().optional(),
    startsAt: z.iso.datetime({ offset: true }),
    meetingPoint: z.string().trim().min(1).max(500),
    meetingPointUrl: z.union([
      z.literal(""),
      z
        .url()
        .max(2048)
        .refine((value) => new URL(value).protocol === "https:"),
    ]),
    spots: z.number().int().min(1).max(100),
    open: z.boolean(),
    hidden: z.boolean(),
  })
  .refine(
    (value) =>
      value.includesOrientation !== undefined || value.type !== undefined,
  )
  .transform(({ type, ...value }) => ({
    ...value,
    includesOrientation: value.includesOrientation ?? type === "orientation",
  }))
  .refine(validOrientationCapacity, {
    message: orientationCapacityMessage,
    path: ["spots"],
  });
export interface EventRow {
  id: string;
  type: "patrol" | "orientation";
  includesOrientation: number;
  seriesId: string | null;
  occurrenceDate: string | null;
  inSignupWindow: number;
  startsAt: number;
  meetingPoint: string;
  meetingPointUrl: string | null;
  spots: number;
  open: number;
  hidden: number;
  cancelledAt: number | null;
  updatedAt: number;
  confirmed: number;
  orientationConfirmed: number;
  medicConfirmed: number;
  medicEligible: number;
  orientationCompleted: number;
  availableSpots: number;
  // This and later nominal occurrences, including bookings outside the page/window.
  futureConfirmed: number;
  futureEditableConfirmed: number;
  signedUp: number;
  orientationSignupBlocked: number;
}
export interface RosterRow {
  id: string;
  eventId: string;
  userId: string;
  name: string;
  completed: number;
}
export interface PublicRosterRow {
  eventId: string;
  name: string;
  category: AttendeeCategory;
}
export interface PublicRoster {
  people: PublicRosterRow[];
  // Opaque membership digest catches swaps even when abbreviated names match.
  version: string;
}
const eventColumns = `
  e.id, CASE WHEN ${includesOrientationSql()} THEN 'orientation' ELSE 'patrol' END AS type,
  ${includesOrientationSql()} AS includesOrientation, e.starts_at AS startsAt,
  e.series_id AS seriesId, e.occurrence_date AS occurrenceDate,
  ${recurringSignupWindowSql()} AS inSignupWindow,
  e.meeting_point AS meetingPoint, e.meeting_point_url AS meetingPointUrl,
  e.spots, e.open, e.hidden,
  e.cancelled_at AS cancelledAt, e.updated_at AS updatedAt`;

export function eventDescription(
  event: Pick<EventRow, "type" | "startsAt" | "meetingPoint"> &
    Partial<Pick<EventRow, "includesOrientation">>,
) {
  return `Patrol${(event.includesOrientation ?? event.type === "orientation") ? " (includes orientation)" : ""}: ${new Intl.DateTimeFormat(
    "en-CA",
    {
      timeZone: "America/Vancouver",
      dateStyle: "full",
      timeStyle: "short",
    },
  ).format(new Date(event.startsAt))}\nMeeting point: ${event.meetingPoint}`;
}
export async function listEvents(
  db: Env["DB"],
  actor: Actor | null,
  selectedOccurrence?: string,
  view: "manage" | "volunteer" = "manage",
) {
  if (!canViewEvents(actor)) return [];
  await ensurePatrolOccurrences(db);
  const organizer = Boolean(
    view === "manage" &&
    actor?.role === "organizer" &&
    actor.applicationSubmitted &&
    actor.active &&
    (!actor.twoFactorEnabled || actor.twoFactorVerified),
  );
  const futureSignups = `SELECT count(*) FROM signup s JOIN event future ON future.id = s.event_id
    WHERE future.series_id = e.series_id AND future.occurrence_date >= e.occurrence_date
      AND future.cancelled_at IS NULL AND future.starts_at > ${nowMsSql}
      AND s.status = 'confirmed'`;
  const select = `SELECT ${eventColumns},
    (SELECT count(*) FROM signup
      WHERE event_id = e.id AND status = 'confirmed') AS confirmed,
    (SELECT count(*) FROM signup s WHERE s.event_id = e.id AND s.status = 'confirmed'
      AND NOT EXISTS(SELECT 1 FROM orientation_completion o WHERE o.user_id = s.user_id)) AS orientationConfirmed,
    EXISTS(SELECT 1 FROM orientation_completion o WHERE o.user_id = ?) AS orientationCompleted,
    (SELECT count(*) FROM signup s WHERE s.event_id = e.id AND s.status = 'confirmed'
      AND ${approvedMedicSql("s.user_id")}) AS medicConfirmed,
    ${approvedMedicSql("?")} AS medicEligible,
    ${organizer ? `(${futureSignups})` : "0"} AS futureConfirmed,
    ${
      organizer
        ? `(${futureSignups}
        AND NOT EXISTS(SELECT 1 FROM event_audit a
          WHERE a.event_id = future.id AND a.action = 'updated'))`
        : "0"
    } AS futureEditableConfirmed,
    EXISTS(SELECT 1 FROM signup
      WHERE event_id = e.id AND user_id = ? AND status = 'confirmed') AS signedUp,
    (${includesOrientationSql()} AND EXISTS(
      SELECT 1 FROM volunteer_status v
      WHERE v.user_id = ? AND v.patrol_approved = 0
        AND NOT EXISTS(SELECT 1 FROM orientation_completion o WHERE o.user_id = v.user_id)
        AND EXISTS(
          SELECT 1 FROM signup s JOIN event booked ON booked.id = s.event_id
          WHERE s.user_id = v.user_id AND s.status = 'confirmed'
            AND ${includesOrientationSql("booked")} AND booked.cancelled_at IS NULL
            AND booked.starts_at > ${nowMsSql}
        )
    )) AS orientationSignupBlocked
    FROM event e`;
  const statement = organizer
    ? db
        .prepare(
          `${select}
        ORDER BY
          (e.id = ?) DESC,
          (e.starts_at > ${nowMsSql}) DESC,
          CASE WHEN e.starts_at > ${nowMsSql}
            THEN e.starts_at END ASC,
          e.starts_at DESC
        LIMIT 100`,
        )
        .bind(
          actor?.id ?? "",
          actor?.id ?? "",
          actor?.id ?? "",
          actor?.id ?? "",
          selectedOccurrence ?? "",
        )
    : db
        .prepare(
          `${select}
        WHERE e.starts_at > ${nowMsSql}
          AND e.cancelled_at IS NULL
          AND ${recurringSignupWindowSql()}
          AND (e.series_id IS NULL OR e.hidden = 0)
          AND ((e.series_id IS NOT NULL AND e.hidden = 0)
            OR (e.open = 1 AND e.hidden = 0) OR EXISTS(
            SELECT 1 FROM signup
            WHERE event_id = e.id AND user_id = ? AND status = 'confirmed'
          ))
        ORDER BY e.starts_at ASC
        LIMIT 100`,
        )
        .bind(
          actor?.id ?? "",
          actor?.id ?? "",
          actor?.id ?? "",
          actor?.id ?? "",
          actor?.id ?? "",
        );
  const rows = await statement.all<EventRow>();
  return rows.results.map((row) => ({
    ...row,
    availableSpots: availableSignupSpots(row, row.confirmed),
  }));
}
export async function findEvent(db: Env["DB"], id: string) {
  const row = await db
    .prepare(`SELECT ${eventColumns} FROM event e WHERE e.id = ?`)
    .bind(id)
    .first<EventRow>();
  if (!row) throw new RequestError(404, "Event not found.");
  return row;
}
function eventAudit(
  db: Env["DB"],
  operation: string,
  eventId: string,
  actorId: string,
  action: string,
  fields: string[] = [],
) {
  return db
    .prepare(
      `INSERT INTO event_audit (id, event_id, actor_id, action, changed_fields, created_at)
        SELECT ?, ?, ?, ?, ?, ?
        WHERE changes() = 1`,
    )
    .bind(
      operation,
      eventId,
      actorId,
      action,
      JSON.stringify(fields),
      Date.now(),
    );
}
function notifyRoster(
  db: Env["DB"],
  operation: string,
  eventId: string,
  subject: string,
  body: string,
  notify: boolean,
) {
  return db
    .prepare(
      `INSERT INTO event_notification (id, operation_id, user_id, subject, body, created_at, delivery_to)
        SELECT lower(hex(randomblob(16))), ?, s.user_id, ?, ?, ?, u.email
        FROM signup s JOIN user u ON u.id=s.user_id AND u.email_verified=1
        WHERE s.event_id = ?
          AND s.status = 'confirmed'
          AND EXISTS (SELECT 1 FROM event_audit WHERE id = ?)
          AND ? = 1`,
    )
    .bind(
      operation,
      subject,
      body,
      Date.now(),
      eventId,
      operation,
      Number(notify),
    );
}
export async function saveEvent(
  db: Env["DB"],
  actor: Actor,
  input: unknown,
  id?: string,
  version?: number,
  notify = false,
) {
  requireOrganizer(actor);
  const parsed = eventSchema.safeParse(input);
  if (!parsed.success)
    throw new RequestError(
      400,
      parsed.error.issues.find(
        (issue) => issue.message === orientationCapacityMessage,
      )?.message ??
        "Check the orientation setting, date, capacity (2–100, or 4–100 with orientation), meeting point, and HTTPS map link.",
    );
  const data = parsed.data;
  const startsAt = new Date(data.startsAt).getTime();
  if (!Number.isFinite(startsAt))
    throw new RequestError(400, "Choose a valid event date.");
  const operation = crypto.randomUUID();
  const now = Date.now();
  try {
    if (!id) {
      id = crypto.randomUUID();
      const results = await db.batch([
        db
          .prepare(
            `INSERT INTO event (
              id, type, includes_orientation, starts_at, meeting_point, meeting_point_url,
              spots, open, hidden, created_by, created_at, updated_at
            )
            SELECT ?, 'patrol', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
            WHERE ${writePermission(true)}`,
          )
          .bind(
            id,
            Number(data.includesOrientation),
            startsAt,
            data.meetingPoint,
            data.meetingPointUrl || null,
            data.spots,
            Number(data.open),
            Number(data.hidden),
            actor.id,
            now,
            now,
            ...permissionValues(actor),
          ),
        eventAudit(db, operation, id, actor.id, "created", Object.keys(data)),
      ]);
      if (!results[0].meta.changes)
        throw new RequestError(
          403,
          "Organizer authorization changed. Sign in again.",
        );
    } else {
      const old = await findEvent(db, id);
      if (old.cancelledAt)
        throw new RequestError(409, "Cancelled events cannot be edited.");
      if (old.startsAt <= now)
        throw new RequestError(409, "Past events cannot be edited.");
      const fields = Object.keys(data).filter((key) => {
        const expected =
          key === "startsAt"
            ? startsAt
            : key === "open" ||
                key === "hidden" ||
                key === "includesOrientation"
              ? Number(data[key])
              : key === "meetingPointUrl"
                ? data[key] || null
                : data[key as keyof typeof data];
        return old[key as keyof EventRow] !== expected;
      });
      if (!fields.length) return { operation, message: "No event changes." };
      const results = await db.batch([
        db
          .prepare(
            `UPDATE event
            SET includes_orientation = ?, starts_at = ?,
                meeting_point = ?,
                meeting_point_url = ?,
                spots = ?,
                open = ?,
                hidden = ?,
                updated_at = ?
            WHERE id = ?
              AND updated_at = ?
              AND cancelled_at IS NULL
              AND starts_at > ${nowMsSql}
              AND ${writePermission(true)}`,
          )
          .bind(
            Number(data.includesOrientation),
            startsAt,
            data.meetingPoint,
            data.meetingPointUrl || null,
            data.spots,
            Number(data.open),
            Number(data.hidden),
            Math.max(now, old.updatedAt + 1),
            id,
            version ?? -1,
            ...permissionValues(actor),
          ),
        eventAudit(db, operation, id, actor.id, "updated", fields),
        notifyRoster(
          db,
          operation,
          id,
          "Your After Hours Outreach event changed",
          `${eventDescription({ ...old, includesOrientation: Number(data.includesOrientation), startsAt, meetingPoint: data.meetingPoint })}\n\n${data.open ? "Registration is open." : "Registration is closed. Your existing spot is still reserved."}`,
          notify,
        ),
      ]);
      if (!results[0].meta.changes)
        throw new RequestError(
          409,
          "This event changed. Reload before editing it.",
        );
      if (old.seriesId) await ensurePatrolOccurrences(db, old.seriesId);
    }
    return { operation, message: "Event saved." };
  } catch (error) {
    return databaseWriteError(error);
  }
}

export async function cancelEvent(
  db: Env["DB"],
  actor: Actor,
  id: string,
  version: number,
  reason: string,
  notify = false,
) {
  requireOrganizer(actor);
  const old = await findEvent(db, id);
  if (old.startsAt <= Date.now())
    throw new RequestError(409, "Past events cannot be cancelled.");
  const operation = crypto.randomUUID();
  const now = Date.now();
  const results = await db.batch([
    db
      .prepare(
        `UPDATE event
        SET cancelled_at = ?, open = 0, hidden = 1, updated_at = ?
        WHERE id = ?
          AND updated_at = ?
          AND cancelled_at IS NULL
          AND starts_at > ${nowMsSql}
          AND ${writePermission(true)}`,
      )
      .bind(
        now,
        Math.max(now, old.updatedAt + 1),
        id,
        version,
        ...permissionValues(actor),
      ),
    eventAudit(db, operation, id, actor.id, "cancelled", ["cancelledAt"]),
    notifyRoster(
      db,
      operation,
      id,
      "Your After Hours Outreach event was cancelled",
      `${eventDescription(old)}\n\nThis event was cancelled.${reason ? `\nReason: ${reason}` : ""}`,
      notify,
    ),
    db
      .prepare(
        `UPDATE signup
        SET status = 'cancelled', updated_at = ?
        WHERE event_id = ?
          AND status = 'confirmed'
          AND EXISTS(SELECT 1 FROM event_audit WHERE id = ?)`,
      )
      .bind(now, id, operation),
  ]);
  if (!results[0].meta.changes)
    throw new RequestError(
      409,
      "This event changed or was already cancelled. Reload the page.",
    );
  if (old.seriesId) await ensurePatrolOccurrences(db, old.seriesId);
  return {
    operation,
    message: "Event cancelled. Existing registrations were cancelled too.",
  };
}

export async function changeSignup(
  db: Env["DB"],
  actor: Actor,
  eventId: string,
  action: "join" | "cancel",
) {
  if (!actor) throw new RequestError(401, "Sign in to register.");
  requireVolunteer(actor);
  if (action === "join") await ensurePatrolOccurrences(db);
  const event = await findEvent(db, eventId);
  if (event.startsAt <= Date.now())
    throw new RequestError(409, "Registration closes when the event starts.");
  const operation = crypto.randomUUID();
  const now = Date.now();
  try {
    if (action === "join") {
      const results = await db.batch([
        db
          .prepare(
            `INSERT INTO signup (id, event_id, user_id, status, created_at, updated_at)
            SELECT ?, ?, ?, 'confirmed', ?, ?
            WHERE ${writePermission()}`,
          )
          .bind(
            crypto.randomUUID(),
            eventId,
            actor.id,
            now,
            now,
            ...permissionValues(actor),
          ),
        eventAudit(db, operation, eventId, actor.id, "signup_joined"),
      ]);
      if (!results[0].meta.changes)
        throw new RequestError(403, "Your sign-in changed. Sign in again.");
    } else {
      const results = await db.batch([
        db
          .prepare(
            `UPDATE signup
            SET status = 'cancelled', updated_at = ?
            WHERE event_id = ?
              AND user_id = ?
              AND status = 'confirmed'
              AND EXISTS(
                SELECT 1 FROM event e
                WHERE e.id = signup.event_id
                  AND e.starts_at > ${nowMsSql}
              )
              AND ${writePermission()}`,
          )
          .bind(now, eventId, actor.id, ...permissionValues(actor)),
        eventAudit(db, operation, eventId, actor.id, "signup_cancelled"),
      ]);
      if (!results[0].meta.changes)
        throw new RequestError(409, "You are not registered for this event.");
    }
    return {
      operation,
      message:
        action === "join"
          ? "Your registration is confirmed."
          : "Your registration was cancelled.",
    };
  } catch (error) {
    return databaseWriteError(error);
  }
}

/** Safe roster for approved event viewers. Recheck visibility in SQL rather than
 * trusting event IDs supplied by a caller. Never return IDs or private profiles. */
export async function listPublicRosters(
  db: Env["DB"],
  actor: Actor,
  eventIds: string[],
): Promise<PublicRoster> {
  requireVolunteer(actor);
  const ids = eventIds.slice(0, 100);
  if (!ids.length) return { people: [], version: "" };
  const rows = await db
    .prepare(
      `SELECT s.id AS membership, s.user_id AS attendeeIdentity, s.event_id AS eventId,
    p.first_name AS firstName, p.last_name AS lastName, ${profileDisplayNameSql} AS legacyName,
    CASE WHEN ${includesOrientationSql()} AND NOT EXISTS (
      SELECT 1 FROM orientation_completion o WHERE o.user_id = s.user_id
    ) THEN 'orientee' WHEN ${approvedMedicSql("s.user_id")} THEN 'medic' ELSE 'volunteer' END AS category
    FROM signup s JOIN event e ON e.id = s.event_id
    JOIN profile p ON p.user_id = s.user_id JOIN user u ON u.id = s.user_id
     WHERE s.status = 'confirmed' AND e.id IN (SELECT value FROM json_each(?))
      AND e.starts_at > ${nowMsSql} AND e.cancelled_at IS NULL
      AND ${recurringSignupWindowSql()}
      AND (e.series_id IS NULL OR e.hidden = 0)
      AND ((e.series_id IS NOT NULL AND e.hidden = 0) OR (e.open = 1 AND e.hidden = 0)
        OR EXISTS (SELECT 1 FROM signup own WHERE own.event_id = e.id AND own.user_id = ? AND own.status = 'confirmed'))
    ORDER BY s.event_id, s.id LIMIT 10000`,
    )
    // One JSON binding keeps a full 100-event page below D1's 100-parameter limit.
    .bind(JSON.stringify(ids), actor.id)
    .all<{
      membership: string;
      attendeeIdentity: string;
      eventId: string;
      firstName: string | null;
      lastName: string | null;
      legacyName: string;
      category: AttendeeCategory;
    }>();
  const people = rows.results.map((row) => ({
    eventId: row.eventId,
    name: publicAttendeeName(row.firstName, row.lastName, row.legacyName),
    category: row.category,
  }));
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(
      JSON.stringify(
        rows.results.map((row, index) => [
          row.membership,
          row.attendeeIdentity,
          people[index],
        ]),
      ),
    ),
  );
  return {
    people,
    version: [...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join(""),
  };
}

export async function listRosters(
  db: Env["DB"],
  actor: Actor,
  eventIds: string[],
) {
  requireOrganizer(actor);
  if (!eventIds.length) return [];
  const ids = eventIds.slice(0, 100);
  const placeholders = ids.map(() => "?").join(", ");
  const rows = await db
    .prepare(
      `SELECT s.id, s.event_id AS eventId, s.user_id AS userId, ${profileDisplayNameSql} AS name,
        EXISTS(SELECT 1 FROM orientation_completion o
          WHERE o.event_id = s.event_id AND o.user_id = s.user_id) AS completed
      FROM signup s
      JOIN profile p ON p.user_id = s.user_id
      JOIN user u ON u.id = s.user_id
      WHERE s.event_id IN (${placeholders}) AND s.status = 'confirmed'
      ORDER BY name
      LIMIT 10000`,
    )
    .bind(...ids)
    .all<RosterRow>();
  return rows.results;
}

export async function manageSignup(
  db: Env["DB"],
  actor: Actor,
  signupId: string,
  destination: string | undefined,
  reason: string,
  notify = false,
) {
  requireOrganizer(actor);
  if (destination) await ensurePatrolOccurrences(db);
  const row = await db
    .prepare(
      `SELECT event_id AS eventId, user_id AS userId
      FROM signup
      WHERE id = ? AND status = 'confirmed'`,
    )
    .bind(signupId)
    .first<{ eventId: string; userId: string }>();
  if (!row) throw new RequestError(404, "Registration not found.");
  const old = await findEvent(db, row.eventId);
  if (old.startsAt <= Date.now())
    throw new RequestError(
      409,
      "Past registrations cannot be removed or moved.",
    );
  if (destination === row.eventId)
    throw new RequestError(400, "Choose a different event.");
  const next = destination ? await findEvent(db, destination) : null;
  const operation = crypto.randomUUID();
  const now = Date.now();
  try {
    const statements = [
      db
        .prepare(
          `UPDATE signup
          SET status = 'cancelled', updated_at = ?
          WHERE id = ?
            AND status = 'confirmed'
            AND EXISTS(
              SELECT 1 FROM event e
              WHERE e.id = signup.event_id
                AND e.starts_at > ${nowMsSql}
            )
            AND ${writePermission(true)}`,
        )
        .bind(now, signupId, ...permissionValues(actor)),
      eventAudit(
        db,
        operation,
        row.eventId,
        actor.id,
        next ? "signup_moved" : "signup_removed",
      ),
    ];
    if (next)
      statements.push(
        db
          .prepare(
            `INSERT INTO signup (id, event_id, user_id, status, created_at, updated_at)
            SELECT ?, ?, ?, 'confirmed', ?, ?
            WHERE EXISTS(SELECT 1 FROM event_audit WHERE id = ?)`,
          )
          .bind(crypto.randomUUID(), next.id, row.userId, now, now, operation),
      );
    statements.push(
      db
        .prepare(
          `INSERT INTO event_notification (id, operation_id, user_id, subject, body, created_at, delivery_to)
          SELECT ?, ?, ?, ?, ?, ?, email FROM user
          WHERE id=? AND email_verified=1 AND EXISTS(SELECT 1 FROM event_audit WHERE id = ?) AND ? = 1`,
        )
        .bind(
          crypto.randomUUID(),
          operation,
          row.userId,
          next
            ? "Your After Hours Outreach event registration was moved"
            : "Your After Hours Outreach event registration was removed",
          `${eventDescription(old)}\n\n${next ? `An organizer moved your registration to:\n${eventDescription(next)}` : "An organizer removed your registration."}${reason ? `\nReason: ${reason}` : ""}`,
          now,
          row.userId,
          operation,
          Number(notify),
        ),
    );
    const results = await db.batch(statements);
    if (!results[0].meta.changes)
      throw new RequestError(
        409,
        "This registration changed. Reload the page.",
      );
    return {
      operation,
      message: next ? "Registration moved." : "Registration removed.",
    };
  } catch (error) {
    return databaseWriteError(error);
  }
}
