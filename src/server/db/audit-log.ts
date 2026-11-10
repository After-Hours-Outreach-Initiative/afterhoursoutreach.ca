import type { AuditCursor, AuditKind } from "../../data/audit-log";
import { auditFieldLabels } from "../../data/audit-log";
import {
  requireOrganizer,
  permissionValues,
  writePermission,
  type Actor,
} from "./access";
import { personDisplayNameSql } from "./sql";

export interface AuditEntry {
  id: string;
  kind: AuditKind;
  createdAt: number;
  action: string;
  actorName: string;
  subjectId: string;
  subjectName: string;
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
): Promise<{ entries: AuditEntry[]; next?: AuditCursor }> {
  requireOrganizer(actor);
  const { results } = await db
    .prepare(
      `
    WITH history AS (
      SELECT a.id, 'person' AS kind, a.created_at AS createdAt, a.action,
        a.actor_id AS actorId, a.subject_id AS subjectId,
        ${displayName("subject", "sp")} AS subjectName,
        NULL AS startsAt, NULL AS firstDate, NULL AS localTime, NULL AS intervalWeeks,
        a.changed_fields AS changedFieldsJson
      FROM audit_log a JOIN user subject ON subject.id = a.subject_id
      LEFT JOIN profile sp ON sp.user_id = subject.id
      UNION ALL
      SELECT a.id, 'event', a.created_at, a.action, a.actor_id, a.event_id,
        CASE WHEN coalesce(e.includes_orientation, e.type = 'orientation')
          THEN 'Patrol with orientation' ELSE 'Patrol' END
          || CASE WHEN trim(e.meeting_point) <> '' THEN ' · ' || e.meeting_point ELSE '' END,
        e.starts_at, NULL, NULL, NULL, a.changed_fields
      FROM event_audit a JOIN event e ON e.id = a.event_id
      UNION ALL
      SELECT a.id, 'series', a.created_at, a.action, a.actor_id, a.series_id,
        'Patrol series' || CASE WHEN trim(s.meeting_point) <> '' THEN ' · ' || s.meeting_point ELSE '' END,
        NULL, s.first_date, s.local_time, s.interval_weeks, a.changed_fields
      FROM patrol_series_audit a JOIN patrol_series s ON s.id = a.series_id
    )
    SELECT h.*, ${displayName("actor", "ap")} AS actorName
    FROM history h JOIN user actor ON actor.id = h.actorId
    LEFT JOIN profile ap ON ap.user_id = actor.id
    WHERE ${writePermission(true)}
      ${before ? "AND (h.createdAt, h.kind, h.id) < (?, ?, ?)" : ""}
    ORDER BY h.createdAt DESC, h.kind DESC, h.id DESC
    LIMIT 51
  `,
    )
    .bind(
      ...permissionValues(actor),
      ...(before ? [before.createdAt, before.kind, before.id] : []),
    )
    .all<
      Omit<AuditEntry, "changedFields"> & {
        actorId: string;
        changedFieldsJson: string | null;
      }
    >();
  const entries = results
    .slice(0, 50)
    .map(({ actorId: _actorId, changedFieldsJson, ...entry }) => ({
      ...entry,
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
