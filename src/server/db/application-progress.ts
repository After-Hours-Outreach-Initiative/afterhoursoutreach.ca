import { includesOrientationSql } from "./sql";

export interface ApplicationProgress {
  submittedAt: number | null;
  naloxoneCompletedAt: number | null;
  applicationApproved: boolean;
  applicationApprovedAt: number | null;
  orientationSignedUpAt: number | null;
  orientationCompletedAt: number | null;
}

export async function loadApplicationProgress(
  db: Env["DB"],
  userId: string,
): Promise<ApplicationProgress> {
  const row = await db
    .prepare(
      `SELECT p.registered_at AS submittedAt,
        p.naloxone_completed_at AS naloxoneCompletedAt,
        v.registration_approved AS applicationApproved,
        (SELECT max(a.created_at) FROM audit_log a
          WHERE a.subject_id=u.id AND a.action='approval_changed'
          AND EXISTS (SELECT 1 FROM json_each(a.changed_fields)
            WHERE value IN ('applicationApproved', 'registrationApproved'))
        ) AS applicationApprovedAt,
        (SELECT min(s.created_at) FROM signup s JOIN event e ON e.id=s.event_id
          WHERE s.user_id=u.id AND s.status='confirmed' AND e.cancelled_at IS NULL
          AND ${includesOrientationSql()}
          AND (e.starts_at > ? OR EXISTS (SELECT 1 FROM orientation_completion o
            WHERE o.user_id=u.id AND o.event_id=e.id))
        ) AS orientationSignedUpAt,
        (SELECT min(e.starts_at) FROM orientation_completion o
          JOIN event e ON e.id=o.event_id WHERE o.user_id=u.id
        ) AS orientationCompletedAt
      FROM user u LEFT JOIN profile p ON p.user_id=u.id
      LEFT JOIN volunteer_status v ON v.user_id=u.id WHERE u.id=?`,
    )
    .bind(Date.now(), userId)
    .first<
      Omit<ApplicationProgress, "applicationApproved"> & {
        applicationApproved: number | null;
      }
    >();
  return {
    submittedAt: row?.submittedAt ?? null,
    naloxoneCompletedAt: row?.naloxoneCompletedAt ?? null,
    applicationApproved: Boolean(row?.applicationApproved),
    // approved_at belongs to patrol approval. Only an application-status audit
    // can date this milestone; legacy approvals without one stay undated.
    applicationApprovedAt: row?.applicationApproved
      ? (row.applicationApprovedAt ?? null)
      : null,
    orientationSignedUpAt: row?.orientationSignedUpAt ?? null,
    orientationCompletedAt: row?.orientationCompletedAt ?? null,
  };
}
