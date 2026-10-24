export interface ApplicationProgress {
  submittedAt: number | null;
  naloxoneCompletedAt: number | null;
  applicationApproved: boolean;
  applicationApprovedAt: number | null;
}

/** Application completion is separate from orientation booking and attendance. */
export function isApplicationComplete(
  progress: Pick<
    ApplicationProgress,
    "submittedAt" | "naloxoneCompletedAt" | "applicationApproved"
  >,
): boolean {
  return (
    progress.submittedAt !== null &&
    progress.naloxoneCompletedAt !== null &&
    progress.applicationApproved
  );
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
        ) AS applicationApprovedAt
      FROM user u LEFT JOIN profile p ON p.user_id=u.id
      LEFT JOIN volunteer_status v ON v.user_id=u.id WHERE u.id=?`,
    )
    .bind(userId)
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
  };
}
