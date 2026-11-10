import type {
  AuditCursor,
  AuditFilters,
  AuditKind,
} from "../../data/audit-log";
import { auditFieldLabels } from "../../data/audit-log";
import {
  requireOrganizer,
  permissionValues,
  writePermission,
  type Actor,
} from "./access";
import { attendeeCategorySql, medicMarkSql, personDisplayNameSql } from "./sql";
import type { AttendeeCategory } from "../../data/event-roster";

/** A person who appears in the audit log, with what their avatar shows. */
export interface AuditUser {
  id: string;
  name: string;
  role: "volunteer" | "organizer";
  category: AttendeeCategory;
  medicMark: boolean;
  approved: boolean;
}

export interface AuditEntry {
  id: string;
  kind: AuditKind;
  createdAt: number;
  action: string;
  actorId: string;
  actorName: string;
  actorApproved: boolean;
  subjectId: string;
  subjectName: string;
  /** Application approval of a person subject; null for events and series. */
  subjectApproved: boolean | null;
  startsAt: number | null;
  firstDate: string | null;
  localTime: string | null;
  intervalWeeks: number | null;
  changedFields: string[];
}

const displayName = (user: string, profile: string) =>
  personDisplayNameSql({
    firstName: `${profile}.first_name`,
    lastName: `${profile}.last_name`,
    preferredName: `${profile}.preferred_name`,
    legacyName: `${user}.name`,
  });

/** Only field names enter the log; private profile answers are never selected. */
export async function listAuditLog(
  db: Env["DB"],
  actor: Actor,
  before?: AuditCursor,
  filters: AuditFilters = { users: [], actions: [] },
): Promise<{ entries: AuditEntry[]; next?: AuditCursor }> {
  requireOrganizer(actor);
  const placeholders = (values: string[]) => values.map(() => "?").join(", ");
  const { results } = await db
    .prepare(
      `
    WITH history AS (
      SELECT a.id, 'person' AS kind, a.created_at AS createdAt, a.action,
        a.actor_id AS actorId, a.subject_id AS subjectId,
        ${displayName("subject", "sp")} AS subjectName,
        coalesce(sv.registration_approved, 0) AS subjectApproved,
        NULL AS startsAt, NULL AS firstDate, NULL AS localTime, NULL AS intervalWeeks,
        a.changed_fields AS changedFieldsJson
      FROM audit_log a JOIN user subject ON subject.id = a.subject_id
      LEFT JOIN profile sp ON sp.user_id = subject.id
      LEFT JOIN volunteer_status sv ON sv.user_id = subject.id
      -- Legacy rows duplicated the patrol approval entry recorded beside them.
      WHERE a.action <> 'orientation_completed'
      UNION ALL
      SELECT a.id, 'event', a.created_at, a.action, a.actor_id, a.event_id,
        CASE WHEN coalesce(e.includes_orientation, e.type = 'orientation')
          THEN 'Patrol with orientation' ELSE 'Patrol' END
          || CASE WHEN trim(e.meeting_point) <> '' THEN ' · ' || e.meeting_point ELSE '' END,
        NULL, e.starts_at, NULL, NULL, NULL, a.changed_fields
      FROM event_audit a JOIN event e ON e.id = a.event_id
      UNION ALL
      SELECT a.id, 'series', a.created_at, a.action, a.actor_id, a.series_id,
        'Patrol series' || CASE WHEN trim(s.meeting_point) <> '' THEN ' · ' || s.meeting_point ELSE '' END,
        NULL, NULL, s.first_date, s.local_time, s.interval_weeks, a.changed_fields
      FROM patrol_series_audit a JOIN patrol_series s ON s.id = a.series_id
    )
    SELECT h.*, ${displayName("actor", "ap")} AS actorName,
      coalesce(av.registration_approved, 0) AS actorApproved
    FROM history h JOIN user actor ON actor.id = h.actorId
    LEFT JOIN profile ap ON ap.user_id = actor.id
    LEFT JOIN volunteer_status av ON av.user_id = actor.id
    WHERE ${writePermission(true)}
      ${filters.users.length ? `AND h.actorId IN (${placeholders(filters.users)})` : ""}
      ${filters.actions.length ? `AND h.kind || ':' || h.action IN (${placeholders(filters.actions)})` : ""}
      ${before ? "AND (h.createdAt, h.kind, h.id) < (?, ?, ?)" : ""}
    ORDER BY h.createdAt DESC, h.kind DESC, h.id DESC
    LIMIT 51
  `,
    )
    .bind(
      ...permissionValues(actor),
      ...filters.users,
      ...filters.actions,
      ...(before ? [before.createdAt, before.kind, before.id] : []),
    )
    .all<
      Omit<
        AuditEntry,
        "changedFields" | "actorApproved" | "subjectApproved"
      > & {
        actorApproved: number;
        subjectApproved: number | null;
        changedFieldsJson: string | null;
      }
    >();
  const entries = results
    .slice(0, 50)
    .map(({ changedFieldsJson, actorApproved, subjectApproved, ...entry }) => ({
      ...entry,
      actorApproved: Boolean(actorApproved),
      subjectApproved:
        subjectApproved === null ? null : Boolean(subjectApproved),
      changedFields: auditFieldLabels(changedFieldsJson),
    }));
  const last = entries.at(-1);
  return {
    entries,
    next:
      results.length > 50 && last
        ? { createdAt: last.createdAt, kind: last.kind, id: last.id }
        : undefined,
  };
}

/** People who appear as the actor of at least one audit entry, by name. */
export async function listAuditUsers(
  db: Env["DB"],
  actor: Actor,
): Promise<AuditUser[]> {
  requireOrganizer(actor);
  const { results } = await db
    .prepare(
      `
    WITH actors AS (
      SELECT actor_id AS id FROM audit_log WHERE action <> 'orientation_completed'
      UNION SELECT actor_id FROM event_audit
      UNION SELECT actor_id FROM patrol_series_audit
    )
    SELECT actor.id, ${displayName("actor", "ap")} AS name, actor.role,
      ${attendeeCategorySql("actor.id")} AS category,
      ${medicMarkSql("actor.id")} AS medicMark,
      coalesce(av.registration_approved, 0) AS approved
    FROM actors JOIN user actor ON actor.id = actors.id
    LEFT JOIN profile ap ON ap.user_id = actor.id
    LEFT JOIN volunteer_status av ON av.user_id = actor.id
    WHERE ${writePermission(true)}
    ORDER BY name COLLATE NOCASE, actor.id
  `,
    )
    .bind(...permissionValues(actor))
    .all<
      Omit<AuditUser, "medicMark" | "approved"> & {
        medicMark: number;
        approved: number;
      }
    >();
  return results.map((user) => ({
    ...user,
    medicMark: Boolean(user.medicMark),
    approved: Boolean(user.approved),
  }));
}
