import { z } from "zod";
import {
  requireOrganizer,
  writePermission,
  permissionValues,
  type Actor,
} from "./access";
import type { RegistrationAnswers } from "../../data/registration";
import { RequestError } from "../http";
import { eventWriteError } from "../events/service";
import { nowMsSql } from "../db/sql";

export interface VolunteerRow {
  id: string;
  name: string;
  role: "volunteer" | "organizer";
  active: number;
  patrolApproved: number;
  updatedAt: number;
  twoFactorEnabled: number;
  orientations: number;
}
export async function listVolunteers(
  db: Env["DB"],
  actor: Actor,
  search = "",
  offset = 0,
) {
  requireOrganizer(actor);
  const rows = await db
    .prepare(
      `SELECT u.id, p.preferred_name AS name, u.role, u.two_factor_enabled AS twoFactorEnabled,
        v.active, v.patrol_approved AS patrolApproved, v.updated_at AS updatedAt,
        (SELECT count(*) FROM orientation_completion o WHERE o.user_id = u.id) AS orientations
      FROM user u
      JOIN profile p ON p.user_id = u.id
      JOIN volunteer_status v ON v.user_id = u.id
      WHERE instr(lower(p.preferred_name), lower(?)) > 0
      ORDER BY p.preferred_name, u.id
      LIMIT 51 OFFSET ?`,
    )
    .bind(search.slice(0, 100), offset)
    .all<VolunteerRow>();
  return { rows: rows.results.slice(0, 50), hasMore: rows.results.length > 50 };
}

/** Log before reading sensitive answers; failed logging means no disclosure. */
export async function viewVolunteerProfile(
  db: Env["DB"],
  actor: Actor,
  userId: string,
) {
  requireOrganizer(actor);
  const subject = await db
    .prepare("SELECT user_id FROM profile WHERE user_id=?")
    .bind(userId)
    .first();
  if (!subject) throw new RequestError(404, "Volunteer not found.");
  const accessId = crypto.randomUUID();
  const results = await db.batch([
    db
      .prepare(
        `INSERT INTO audit_log (id, actor_id, subject_id, action, created_at)
        SELECT ?, ?, ?, 'profile_viewed', ?
        WHERE ${writePermission(true)}`,
      )
      .bind(accessId, actor.id, userId, Date.now(), ...permissionValues(actor)),
    db
      .prepare(
        `SELECT preferred_name AS name, coalesce(pronouns, '') AS pronouns,
          phone, birth_date AS birthDate,
          emergency_contact_name AS emergencyName,
          emergency_contact_phone AS emergencyPhone,
          emergency_contact_relationship AS emergencyRelationship,
          heard_about_us AS heardAboutUs, motivation, teams,
          medical_certification AS certification, training_experience AS experience,
          coalesce(medical_conditions, '') AS medicalConditions
        FROM profile
        WHERE user_id = ? AND EXISTS(SELECT 1 FROM audit_log WHERE id = ?)`,
      )
      .bind(userId, accessId),
  ]);
  if (!results[0].meta.changes)
    throw new RequestError(
      403,
      "Organizer authorization changed. Sign in again.",
    );
  const row = results[1].results[0] as
    (Omit<RegistrationAnswers, "teams"> & { teams: string }) | undefined;
  return row ? { ...row, teams: JSON.parse(row.teams) as string[] } : null;
}

export const statusSchema = z.strictObject({
  userId: z.string().min(1).max(200),
  version: z.number().int().nonnegative(),
  active: z.boolean(),
  patrolApproved: z.boolean(),
});
export async function setVolunteerStatus(
  db: Env["DB"],
  actor: Actor,
  input: unknown,
) {
  requireOrganizer(actor);
  const parsed = statusSchema.safeParse(input);
  if (!parsed.success)
    throw new RequestError(400, "Choose a volunteer and their access status.");
  const { userId, version, active, patrolApproved } = parsed.data;
  const old = await db
    .prepare(
      `SELECT active, patrol_approved AS patrolApproved
      FROM volunteer_status
      WHERE user_id = ?`,
    )
    .bind(userId)
    .first<{ active: number; patrolApproved: number }>();
  if (!old) throw new RequestError(404, "Volunteer not found.");
  const fields = [
    old.active !== Number(active) ? "active" : "",
    old.patrolApproved !== Number(patrolApproved) ? "patrolApproved" : "",
  ].filter(Boolean);
  if (!fields.length)
    return { operation: crypto.randomUUID(), message: "No access changes." };
  const operation = crypto.randomUUID();
  const now = Math.max(Date.now(), version + 1);
  try {
    const results = await db.batch([
      db
        .prepare(
          `UPDATE volunteer_status
          SET active = ?,
              patrol_approved = ?,
              approved_by = CASE WHEN patrol_approved = ? THEN approved_by ELSE ? END,
              approved_at = CASE WHEN patrol_approved = ? THEN approved_at ELSE ? END,
              updated_at = ?
          WHERE user_id = ?
            AND updated_at = ?
            AND ${writePermission(true)}`,
        )
        .bind(
          Number(active),
          Number(patrolApproved),
          Number(patrolApproved),
          patrolApproved ? actor.id : null,
          Number(patrolApproved),
          patrolApproved ? now : null,
          now,
          userId,
          version,
          ...permissionValues(actor),
        ),
      db
        .prepare(
          `INSERT INTO audit_log (id, actor_id, subject_id, action, changed_fields, created_at)
          SELECT ?, ?, ?, ?, ?, ?
          WHERE changes() = 1`,
        )
        .bind(
          operation,
          actor.id,
          userId,
          fields.includes("patrolApproved")
            ? "approval_changed"
            : "active_changed",
          JSON.stringify(fields),
          now,
        ),
      // Queue before cancelling so the recipient still has the original event details.
      db
        .prepare(
          `INSERT INTO event_notification (id, operation_id, user_id, subject, body, created_at)
          SELECT lower(hex(randomblob(16))), ?, s.user_id,
            'Your After Hours Outreach signup was cancelled',
            'Your signup for ' || e.type || ' at ' || e.meeting_point || ' was cancelled because your volunteer access changed. Check Your account or contact an organizer.', ?
          FROM signup s
          JOIN event e ON e.id = s.event_id
          WHERE s.user_id = ?
            AND s.status = 'confirmed'
            AND e.starts_at > ?
            AND (? = 0 OR (? = 0 AND e.type = 'patrol'))
            AND EXISTS(SELECT 1 FROM audit_log WHERE id = ?)`,
        )
        .bind(
          operation,
          now,
          userId,
          now,
          Number(active),
          Number(patrolApproved),
          operation,
        ),
      db
        .prepare(
          `UPDATE signup
          SET status = 'cancelled', updated_at = ?
          WHERE user_id = ?
            AND status = 'confirmed'
            AND event_id IN(
              SELECT id FROM event
              WHERE starts_at > ? AND (? = 0 OR (? = 0 AND type = 'patrol'))
            )
            AND EXISTS(SELECT 1 FROM audit_log WHERE id = ?)`,
        )
        .bind(
          now,
          userId,
          now,
          Number(active),
          Number(patrolApproved),
          operation,
        ),
      db
        .prepare(
          `INSERT INTO event_notification (id, operation_id, user_id, subject, body, created_at)
          SELECT ?, ?, ?, 'Your After Hours Outreach volunteer access changed', ?, ?
          WHERE EXISTS(SELECT 1 FROM audit_log WHERE id = ?)`,
        )
        .bind(
          crypto.randomUUID(),
          operation,
          userId,
          `Volunteer account: ${active ? "active" : "inactive"}. Patrol access: ${patrolApproved ? "approved" : "not approved"}. Orientation attendance does not automatically grant patrol approval.`,
          now,
          operation,
        ),
    ]);
    if (!results[0].meta.changes)
      throw new RequestError(
        409,
        "This volunteer's status changed. Reload before saving.",
      );
    return { operation, message: "Volunteer access saved." };
  } catch (error) {
    return eventWriteError(error);
  }
}

export async function setRole(
  db: Env["DB"],
  actor: Actor,
  userId: string,
  role: "volunteer" | "organizer",
) {
  requireOrganizer(actor);
  const target = await db
    .prepare(
      `SELECT u.role, u.email_verified AS verified, v.active
      FROM user u
      JOIN profile p ON p.user_id = u.id
      JOIN volunteer_status v ON v.user_id = u.id
      WHERE u.id = ?`,
    )
    .bind(userId)
    .first<{
      role: string;
      verified: number;
      active: number;
    }>();
  if (!target) throw new RequestError(404, "Registered volunteer not found.");
  if (target.role === role)
    return { operation: crypto.randomUUID(), message: "Role is unchanged." };
  if (role === "organizer" && (!target.verified || !target.active))
    throw new RequestError(
      409,
      "New organizers need a verified email and an active registration first.",
    );
  const operation = crypto.randomUUID();
  const now = Date.now();
  try {
    const results = await db.batch([
      db
        .prepare(
          `UPDATE user
          SET role = ?, updated_at = ?
          WHERE id = ?
            AND role = ?
            AND ${writePermission(true)}
            AND (? = 'volunteer' OR (email_verified = 1 AND EXISTS(
              SELECT 1 FROM volunteer_status WHERE user_id = ? AND active = 1
            )))`,
        )
        .bind(
          role,
          now,
          userId,
          target.role,
          ...permissionValues(actor),
          role,
          userId,
        ),
      db
        .prepare(
          `INSERT INTO audit_log (id, actor_id, subject_id, action, changed_fields, created_at)
          SELECT ?, ?, ?, 'role_changed', '["role"]', ?
          WHERE changes() = 1`,
        )
        .bind(operation, actor.id, userId, now),
      db
        .prepare(
          `DELETE FROM session
          WHERE user_id = ? AND EXISTS(SELECT 1 FROM audit_log WHERE id = ?)`,
        )
        .bind(userId, operation),
      db
        .prepare(
          `INSERT INTO event_notification (id, operation_id, user_id, subject, body, created_at)
          SELECT ?, ?, ?, 'Your After Hours Outreach account role changed', ?, ?
          WHERE EXISTS(SELECT 1 FROM audit_log WHERE id = ?)`,
        )
        .bind(
          crypto.randomUUID(),
          operation,
          userId,
          `Your role is now ${role}. Sign in again to continue.`,
          now,
          operation,
        ),
    ]);
    if (!results[0].meta.changes)
      throw new RequestError(
        409,
        "This account's role changed. Reload the page.",
      );
    return {
      operation,
      message: "Role saved. The volunteer must sign in again.",
    };
  } catch (error) {
    return eventWriteError(error);
  }
}

export async function completeOrientation(
  db: Env["DB"],
  actor: Actor,
  userId: string,
  eventId: string,
) {
  requireOrganizer(actor);
  const eligible = await db
    .prepare(
      `SELECT e.id
      FROM event e
      JOIN signup s ON s.event_id = e.id
      WHERE e.id = ?
        AND e.type = 'orientation'
        AND e.cancelled_at IS NULL
        AND e.starts_at <= ?
        AND s.user_id = ?
        AND s.status = 'confirmed'`,
    )
    .bind(eventId, Date.now(), userId)
    .first();
  if (!eligible)
    throw new RequestError(
      409,
      "Only attendees signed up for an orientation that has started can be marked completed.",
    );
  const operation = crypto.randomUUID();
  const results = await db.batch([
    db
      .prepare(
        `INSERT INTO orientation_completion (id, user_id, event_id, marked_by, marked_at)
        SELECT ?, ?, ?, ?, ?
        WHERE ${writePermission(true)}
          AND EXISTS(
            SELECT 1 FROM event e
            JOIN signup s ON s.event_id = e.id
            WHERE e.id = ?
              AND s.user_id = ?
              AND s.status = 'confirmed'
              AND e.type = 'orientation'
              AND e.cancelled_at IS NULL
              AND e.starts_at <= ${nowMsSql}
          )
        ON CONFLICT(user_id, event_id) DO NOTHING`,
      )
      .bind(
        crypto.randomUUID(),
        userId,
        eventId,
        actor.id,
        Date.now(),
        ...permissionValues(actor),
        eventId,
        userId,
      ),
    db
      .prepare(
        `INSERT INTO audit_log (id, actor_id, subject_id, action, changed_fields, created_at)
        SELECT ?, ?, ?, 'orientation_completed', '["orientationCompletion"]', ?
        WHERE changes() = 1`,
      )
      .bind(operation, actor.id, userId, Date.now()),
  ]);
  if (!results[0].meta.changes) {
    const recorded = await db
      .prepare(
        "SELECT id FROM orientation_completion WHERE user_id=? AND event_id=?",
      )
      .bind(userId, eventId)
      .first();
    if (!recorded)
      throw new RequestError(
        409,
        "Attendance or organizer authorization changed. Reload the page.",
      );
  }
  return {
    operation,
    message: "Orientation marked completed. Patrol approval is unchanged.",
  };
}
