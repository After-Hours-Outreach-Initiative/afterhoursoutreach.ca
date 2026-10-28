export interface ApplicationProgress {
  submittedAt: number | null;
  naloxoneCompletedAt: number | null;
  applicationApproved: boolean;
  applicationApprovedAt: number | null;
  discordRequired?: boolean;
  discordCompletedAt?: number | null;
}

/** Application completion is separate from orientation booking and attendance. */
export function isApplicationComplete(
  progress: Pick<
    ApplicationProgress,
    | "submittedAt"
    | "naloxoneCompletedAt"
    | "applicationApproved"
    | "discordRequired"
    | "discordCompletedAt"
  >,
): boolean {
  return (
    progress.submittedAt !== null &&
    progress.naloxoneCompletedAt !== null &&
    (!progress.discordRequired || progress.discordCompletedAt != null) &&
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
        (p.user_id IS NULL OR EXISTS(SELECT 1 FROM discord_requirement WHERE user_id=u.id)) AS discordRequired,
        (SELECT completed_at FROM discord_link WHERE user_id=u.id) AS discordCompletedAt,
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
      Omit<ApplicationProgress, "applicationApproved" | "discordRequired"> & {
        applicationApproved: number | null;
        discordRequired: number;
      }
    >();
  return {
    submittedAt: row?.submittedAt ?? null,
    naloxoneCompletedAt: row?.naloxoneCompletedAt ?? null,
    applicationApproved: Boolean(row?.applicationApproved),
    discordRequired: Boolean(row?.discordRequired),
    discordCompletedAt: row?.discordCompletedAt ?? null,
    // approved_at belongs to patrol approval. Only an application-status audit
    // can date this milestone; legacy approvals without one stay undated.
    applicationApprovedAt: row?.applicationApproved
      ? (row.applicationApprovedAt ?? null)
      : null,
  };
}
