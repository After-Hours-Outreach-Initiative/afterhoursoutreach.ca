import { z } from "zod";
import type { Actor } from "../accounts/access";
import {
  requireOrganizer,
  requireVolunteer,
  writePermission,
  permissionValues,
} from "../accounts/access";
import { RequestError } from "../http";

export const eventSchema = z.strictObject({
  type: z.enum(["patrol", "orientation"]),
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
});
export interface EventRow {
  id: string;
  type: "patrol" | "orientation";
  startsAt: number;
  meetingPoint: string;
  meetingPointUrl: string | null;
  spots: number;
  open: number;
  hidden: number;
  cancelledAt: number | null;
  updatedAt: number;
  confirmed: number;
  signedUp: number;
}
const eventColumns = `e.id, e.type, e.starts_at AS startsAt, e.meeting_point AS meetingPoint,
  e.meeting_point_url AS meetingPointUrl, e.spots, e.open, e.hidden, e.cancelled_at AS cancelledAt, e.updated_at AS updatedAt`;

export function eventDescription(
  event: Pick<EventRow, "type" | "startsAt" | "meetingPoint">,
) {
  return `${event.type === "patrol" ? "Patrol" : "Orientation"}: ${new Intl.DateTimeFormat(
    "en-CA",
    {
      timeZone: "America/Vancouver",
      dateStyle: "full",
      timeStyle: "short",
    },
  ).format(new Date(event.startsAt))}\nMeeting point: ${event.meetingPoint}`;
}
export async function listEvents(db: Env["DB"], actor: Actor | null) {
  const organizer = Boolean(
    actor?.role === "organizer" &&
    actor.registered &&
    actor.active &&
    (!actor.twoFactorEnabled || actor.twoFactorVerified),
  );
  const rows = await db
    .prepare(
      `SELECT ${eventColumns},
    (SELECT count(*) FROM signup WHERE event_id = e.id AND status = 'confirmed') AS confirmed,
    EXISTS(SELECT 1 FROM signup WHERE event_id = e.id AND user_id = ? AND status = 'confirmed') AS signedUp
    FROM event e WHERE ${organizer ? "1 = 1" : "e.starts_at > ? AND e.cancelled_at IS NULL AND (e.hidden = 0 OR EXISTS(SELECT 1 FROM signup WHERE event_id=e.id AND user_id=? AND status='confirmed'))"}
    ORDER BY ${organizer ? "(e.starts_at > (julianday('now') - 2440587.5) * 86400000) DESC, CASE WHEN e.starts_at > (julianday('now') - 2440587.5) * 86400000 THEN e.starts_at END ASC, e.starts_at DESC" : "e.starts_at ASC"} LIMIT 100`,
    )
    .bind(actor?.id ?? "", ...(organizer ? [] : [Date.now(), actor?.id ?? ""]))
    .all<EventRow>();
  return rows.results;
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
    SELECT ?, ?, ?, ?, ?, ? WHERE changes() = 1`,
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
) {
  return db
    .prepare(
      `INSERT INTO event_notification (id, operation_id, user_id, subject, body, created_at)
    SELECT lower(hex(randomblob(16))), ?, s.user_id, ?, ?, ? FROM signup s
    WHERE s.event_id = ? AND s.status = 'confirmed' AND EXISTS (SELECT 1 FROM event_audit WHERE id = ?)`,
    )
    .bind(operation, subject, body, Date.now(), eventId, operation);
}
export function eventWriteError(error: unknown): never {
  if (error instanceof RequestError) throw error;
  const message =
    error instanceof Error
      ? `${error.message} ${error.cause instanceof Error ? error.cause.message : ""}`
      : "";
  if (message.includes("event_full"))
    throw new RequestError(409, "This event is full.");
  if (message.includes("signup_not_eligible"))
    throw new RequestError(
      403,
      "This event is closed or you are not eligible to sign up.",
    );
  if (message.includes("capacity_below_signups"))
    throw new RequestError(
      409,
      "Capacity cannot be lower than the number of signups.",
    );
  if (message.includes("last_organizer"))
    throw new RequestError(409, "Keep at least one active organizer.");
  if (message.includes("UNIQUE constraint failed: signup"))
    throw new RequestError(409, "You are already signed up.");
  throw error;
}

export async function saveEvent(
  db: Env["DB"],
  actor: Actor,
  input: unknown,
  id?: string,
  version?: number,
) {
  requireOrganizer(actor);
  const parsed = eventSchema.safeParse(input);
  if (!parsed.success)
    throw new RequestError(
      400,
      "Check the event type, date, capacity (1–100), meeting point, and HTTPS map link.",
    );
  const data = parsed.data;
  const startsAt = new Date(data.startsAt).getTime();
  if (!Number.isFinite(startsAt) || startsAt <= Date.now())
    throw new RequestError(400, "Choose a future event date.");
  const operation = crypto.randomUUID();
  const now = Date.now();
  try {
    if (!id) {
      id = crypto.randomUUID();
      const results = await db.batch([
        db
          .prepare(
            `INSERT INTO event (id,type,starts_at,meeting_point,meeting_point_url,spots,open,hidden,created_by,created_at,updated_at) SELECT ?,?,?,?,?,?,?,?,?,?,? WHERE ${writePermission(true)}`,
          )
          .bind(
            id,
            data.type,
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
      if (old.type !== data.type)
        throw new RequestError(
          409,
          "An existing event's type cannot be changed. Create another event instead.",
        );
      const fields = Object.keys(data).filter((key) => {
        const expected =
          key === "startsAt"
            ? startsAt
            : key === "open" || key === "hidden"
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
            `UPDATE event SET starts_at=?,meeting_point=?,meeting_point_url=?,spots=?,open=?,hidden=?,updated_at=? WHERE id=? AND updated_at=? AND cancelled_at IS NULL AND starts_at > (julianday('now') - 2440587.5) * 86400000 AND ${writePermission(true)}`,
          )
          .bind(
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
          `${eventDescription({ ...old, startsAt, meetingPoint: data.meetingPoint })}\n\n${data.open ? "Signups are open." : "Signups are closed. Your existing spot is still reserved."}`,
        ),
      ]);
      if (!results[0].meta.changes)
        throw new RequestError(
          409,
          "This event changed. Reload before editing it.",
        );
    }
    return { operation, message: "Event saved." };
  } catch (error) {
    return eventWriteError(error);
  }
}

export async function cancelEvent(
  db: Env["DB"],
  actor: Actor,
  id: string,
  version: number,
  reason: string,
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
        `UPDATE event SET cancelled_at=?,open=0,hidden=1,updated_at=? WHERE id=? AND updated_at=? AND cancelled_at IS NULL AND starts_at > (julianday('now') - 2440587.5) * 86400000 AND ${writePermission(true)}`,
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
    ),
    db
      .prepare(
        "UPDATE signup SET status='cancelled',updated_at=? WHERE event_id=? AND status='confirmed' AND EXISTS(SELECT 1 FROM event_audit WHERE id=?)",
      )
      .bind(now, id, operation),
  ]);
  if (!results[0].meta.changes)
    throw new RequestError(
      409,
      "This event changed or was already cancelled. Reload the page.",
    );
  return {
    operation,
    message: "Event cancelled. Existing signups were cancelled too.",
  };
}

export async function changeSignup(
  db: Env["DB"],
  actor: Actor,
  eventId: string,
  action: "join" | "cancel",
) {
  if (!actor) throw new RequestError(401, "Sign in to take a spot.");
  if (action === "join") requireVolunteer(actor);
  const event = await findEvent(db, eventId);
  if (event.startsAt <= Date.now())
    throw new RequestError(409, "Signups close when the event starts.");
  const operation = crypto.randomUUID();
  const now = Date.now();
  try {
    if (action === "join") {
      const results = await db.batch([
        db
          .prepare(
            `INSERT INTO signup (id,event_id,user_id,status,created_at,updated_at) SELECT ?,?,?,'confirmed',?,? WHERE ${writePermission()}`,
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
        db
          .prepare(
            `INSERT INTO event_notification(id,operation_id,user_id,subject,body,created_at) SELECT ?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM event_audit WHERE id=?)`,
          )
          .bind(
            crypto.randomUUID(),
            operation,
            actor.id,
            "Your After Hours Outreach signup",
            `${eventDescription(event)}\n\nYour spot is confirmed. You can cancel from the events page before it starts.`,
            now,
            operation,
          ),
      ]);
      if (!results[0].meta.changes)
        throw new RequestError(403, "Your sign-in changed. Sign in again.");
    } else {
      const results = await db.batch([
        db
          .prepare(
            `UPDATE signup SET status='cancelled',updated_at=? WHERE event_id=? AND user_id=? AND status='confirmed'
            AND EXISTS(SELECT 1 FROM event e WHERE e.id=signup.event_id AND e.starts_at > (julianday('now') - 2440587.5) * 86400000) AND ${writePermission()}`,
          )
          .bind(now, eventId, actor.id, ...permissionValues(actor)),
        eventAudit(db, operation, eventId, actor.id, "signup_cancelled"),
        db
          .prepare(
            `INSERT INTO event_notification (id,operation_id,user_id,subject,body,created_at)
          SELECT ?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM event_audit WHERE id=?)`,
          )
          .bind(
            crypto.randomUUID(),
            operation,
            actor.id,
            "Your After Hours Outreach signup was cancelled",
            `${eventDescription(event)}\n\nYou cancelled your spot.`,
            now,
            operation,
          ),
      ]);
      if (!results[0].meta.changes)
        throw new RequestError(409, "You are not signed up for this event.");
    }
    return {
      operation,
      message:
        action === "join"
          ? "Your spot is confirmed."
          : "Your signup was cancelled.",
    };
  } catch (error) {
    return eventWriteError(error);
  }
}

export async function listRosters(
  db: Env["DB"],
  actor: Actor,
  eventIds: string[],
) {
  requireOrganizer(actor);
  if (!eventIds.length) return [];
  const rows = await db
    .prepare(
      `SELECT s.id, s.event_id AS eventId, s.user_id AS userId, p.preferred_name AS name,
    EXISTS(SELECT 1 FROM orientation_completion o WHERE o.event_id=s.event_id AND o.user_id=s.user_id) AS completed
    FROM signup s JOIN profile p ON p.user_id=s.user_id WHERE s.event_id IN (${eventIds
      .slice(0, 100)
      .map(() => "?")
      .join(
        ",",
      )}) AND s.status='confirmed' ORDER BY p.preferred_name LIMIT 10000`,
    )
    .bind(...eventIds.slice(0, 100))
    .all<{
      id: string;
      eventId: string;
      userId: string;
      name: string;
      completed: number;
    }>();
  return rows.results;
}

export async function manageSignup(
  db: Env["DB"],
  actor: Actor,
  signupId: string,
  destination: string | undefined,
  reason: string,
) {
  requireOrganizer(actor);
  const row = await db
    .prepare(
      "SELECT event_id AS eventId, user_id AS userId FROM signup WHERE id=? AND status='confirmed'",
    )
    .bind(signupId)
    .first<{ eventId: string; userId: string }>();
  if (!row) throw new RequestError(404, "Signup not found.");
  const old = await findEvent(db, row.eventId);
  if (old.startsAt <= Date.now())
    throw new RequestError(409, "Past signups cannot be removed or moved.");
  if (destination === row.eventId)
    throw new RequestError(400, "Choose a different event.");
  const next = destination ? await findEvent(db, destination) : null;
  const operation = crypto.randomUUID();
  const now = Date.now();
  try {
    const statements = [
      db
        .prepare(
          `UPDATE signup SET status='cancelled',updated_at=? WHERE id=? AND status='confirmed'
          AND EXISTS(SELECT 1 FROM event e WHERE e.id=signup.event_id AND e.starts_at > (julianday('now') - 2440587.5) * 86400000) AND ${writePermission(true)}`,
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
            `INSERT INTO signup(id,event_id,user_id,status,created_at,updated_at)
      SELECT ?,?,?,'confirmed',?,? WHERE EXISTS(SELECT 1 FROM event_audit WHERE id=?)`,
          )
          .bind(crypto.randomUUID(), next.id, row.userId, now, now, operation),
      );
    statements.push(
      db
        .prepare(
          `INSERT INTO event_notification(id,operation_id,user_id,subject,body,created_at)
      SELECT ?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM event_audit WHERE id=?)`,
        )
        .bind(
          crypto.randomUUID(),
          operation,
          row.userId,
          next
            ? "Your After Hours Outreach signup was moved"
            : "Your After Hours Outreach signup was removed",
          `${eventDescription(old)}\n\n${next ? `An organizer moved your signup to:\n${eventDescription(next)}` : "An organizer removed your signup."}${reason ? `\nReason: ${reason}` : ""}`,
          now,
          operation,
        ),
    );
    const results = await db.batch(statements);
    if (!results[0].meta.changes)
      throw new RequestError(409, "This signup changed. Reload the page.");
    return { operation, message: next ? "Signup moved." : "Signup removed." };
  } catch (error) {
    return eventWriteError(error);
  }
}
