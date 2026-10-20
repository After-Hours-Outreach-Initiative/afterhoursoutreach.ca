import type { AuthBindings } from "../auth";
import type { ProfileSaveOptions } from "./profiles";
import { emailPolicy } from "./policy";
import { hashAuthValue } from "./rate-limits";

export const submissionNotificationRecipients = [
  "ivan.zheng@afterhoursoutreach.ca",
  "info@afterhoursoutreach.ca",
  "molina.dewilde@afterhoursoutreach.ca",
] as const;

// Resend retains keys for 24 hours. Keep a full hour of safety margin, and
// NEVER mint a replacement key after ambiguous acceptance or expiration.
// https://resend.com/docs/dashboard/emails/idempotency-keys
export const submissionRetryWindowMs = 23 * 60 * 60 * 1000;
const leaseMs = 2 * 60 * 1000;

export function submissionNotificationMode(
  bindings: Pick<AuthBindings, "APP_ENV">,
) {
  if (import.meta.env?.MODE === "preview" || bindings.APP_ENV === "preview")
    return "preview";
  if (import.meta.env?.DEV || bindings.APP_ENV === "local") return "local";
  return bindings.APP_ENV === "production" ? "production" : "preview";
}

/** Called only inside saveProfile's winning first-submission D1 transaction. */
export function submissionNotificationStatements(
  bindings: AuthBindings,
): NonNullable<ProfileSaveOptions["firstSubmissionStatements"]> {
  const mode = submissionNotificationMode(bindings);
  return ({ userId, operationId, writeGuard }) =>
    submissionNotificationRecipients.map((recipient) =>
      bindings.DB.prepare(
        `INSERT INTO application_submission_notification
          (id,operation_id,user_id,recipient,mode,payload,status,next_attempt_at,created_at)
        SELECT ?,?,user_id,?,?,
          CASE WHEN ?='preview' THEN NULL ELSE json_object(
            'from','After Hours Outreach <noreply@afterhoursoutreach.ca>',
            'to',json_array(?),
            'subject','New volunteer application submitted',
            'text','Applicant: ' || replace(replace(coalesce(
              nullif(trim(json_extract(submitted_application,'$.answers.preferredName')),''),
              trim(json_extract(submitted_application,'$.answers.firstName') || ' ' ||
                CASE WHEN json_extract(submitted_application,'$.answers.middleNames') != ''
                  THEN json_extract(submitted_application,'$.answers.middleNames') || ' ' ELSE '' END ||
                json_extract(submitted_application,'$.answers.lastName'))
            ),char(13),' '),char(10),' ') ||
              char(10) || 'Submitted: ' || json_extract(submitted_application,'$.submittedAt') ||
              char(10) || 'Organizer review (authorized organizer sign-in required): ' || ?
          ) END,?,registered_at,registered_at
        FROM profile WHERE user_id=? AND submitted_application IS NOT NULL AND ${writeGuard}`,
      ).bind(
        crypto.randomUUID(),
        operationId,
        recipient,
        mode,
        mode,
        recipient,
        // Not a capability URL; the existing route enforces organizer access.
        `https://afterhoursoutreach.ca/volunteer/volunteers/${encodeURIComponent(userId)}`,
        mode === "preview" ? "suppressed" : "pending",
        userId,
        operationId,
      ),
    );
}

export interface SubmissionNotification {
  id: string;
  payload: string;
  attempts: number;
  first_attempt_at: number | null;
}

export async function pendingSubmissionNotifications(
  db: Env["DB"],
  mode: "production" | "local",
  now: number,
  limit: number,
  operationId?: string,
) {
  // Retain terminal ledger rows. Unattempted mail does not expire during quota
  // or configuration outages; only an actual attempt starts the safety clock.
  const expiration = await db
    .prepare(
      `UPDATE application_submission_notification SET status='expired',lease_until=NULL
    WHERE mode=? AND status IN ('pending','sending') AND first_attempt_at <= ?
      AND (lease_until IS NULL OR lease_until <= ?)`,
    )
    .bind(mode, now - submissionRetryWindowMs, now)
    .run();
  const result = await db
    .prepare(
      `SELECT id FROM application_submission_notification
    WHERE mode=? AND status IN ('pending','sending') AND next_attempt_at <= ?
      AND (lease_until IS NULL OR lease_until <= ?)
      AND (first_attempt_at IS NULL OR first_attempt_at > ?)
      ${operationId ? "AND operation_id=?" : ""}
    ORDER BY next_attempt_at,created_at,id LIMIT ?`,
    )
    .bind(
      mode,
      now,
      now,
      now - submissionRetryWindowMs,
      ...(operationId ? [operationId] : []),
      limit,
    )
    .all<{ id: string }>();
  return { notifications: result.results, expired: expiration.meta.changes };
}

export function claimSubmissionNotification(
  db: Env["DB"],
  id: string,
  mode: "production" | "local",
  token: string,
  now: number,
) {
  return db
    .prepare(
      `UPDATE application_submission_notification SET status='sending',
      outcome=CASE WHEN status='sending' THEN 'unconfirmed' ELSE outcome END,
      lease_token=?,lease_until=?
    WHERE id=? AND mode=? AND status IN ('pending','sending')
      AND next_attempt_at <= ? AND (lease_until IS NULL OR lease_until <= ?)
      AND (first_attempt_at IS NULL OR first_attempt_at > ?)
    RETURNING id,payload,attempts,first_attempt_at`,
    )
    .bind(
      token,
      now + leaseMs,
      id,
      mode,
      now,
      now,
      now - submissionRetryWindowMs,
    )
    .first<SubmissionNotification>();
}

/** Reserve the SAME shared sign-in/event budget atomically with the outbox mark.
 * A same-window idempotent replay costs no extra email; a new UTC day reserves
 * again conservatively. A crash cannot consume quota without recording it.
 */
export async function beginSubmissionNotificationAttempt(
  bindings: AuthBindings,
  id: string,
  token: string,
  now: number,
) {
  const start =
    Math.floor(now / emailPolicy.budgetWindowMs) * emailPolicy.budgetWindowMs;
  const key = await hashAuthValue(
    bindings.BETTER_AUTH_SECRET,
    `rate:send-total:${emailPolicy.budgetWindowMs}:${start}`,
  );
  const db = bindings.DB;
  const results = await db.batch([
    db
      .prepare(
        `INSERT INTO auth_rate_limit (key,count,expires_at)
      SELECT ?,1,? WHERE EXISTS (SELECT 1 FROM application_submission_notification
        WHERE id=? AND status='sending' AND mode='production' AND lease_token=?
          AND lease_until > ? AND budget_window IS NOT ?
          AND (first_attempt_at IS NULL OR first_attempt_at > ?))
      ON CONFLICT(key) DO UPDATE SET count=count+1 WHERE count < ?`,
      )
      .bind(
        key,
        start + emailPolicy.budgetWindowMs,
        id,
        token,
        now,
        start,
        now - submissionRetryWindowMs,
        emailPolicy.dailyLimit,
      ),
    db
      .prepare(
        `UPDATE application_submission_notification SET budget_window=?
      WHERE id=? AND lease_token=? AND changes()=1`,
      )
      .bind(start, id, token),
    db
      .prepare(
        `UPDATE application_submission_notification
      SET first_attempt_at=coalesce(first_attempt_at,?),attempts=attempts+1
      WHERE id=? AND lease_token=? AND status='sending' AND mode='production'
        AND lease_until > ? AND budget_window=?
        AND (first_attempt_at IS NULL OR first_attempt_at > ?)
      RETURNING id,payload,attempts,first_attempt_at`,
      )
      .bind(now, id, token, now, start, now - submissionRetryWindowMs),
  ]);
  return (results[2].results[0] as SubmissionNotification | undefined) ?? null;
}

export async function finishSubmissionNotification(
  db: Env["DB"],
  id: string,
  token: string,
  outcome: "sent" | "local" | "failed" | "unconfirmed" | null,
  now: number,
  nextAttemptAt: number,
) {
  const accepted = outcome === "sent" || outcome === "local";
  await db
    .prepare(
      `UPDATE application_submission_notification SET status=?,sent_at=?,
      outcome=CASE WHEN ?=1 THEN NULL WHEN outcome='unconfirmed' THEN outcome ELSE coalesce(?,outcome) END,
      next_attempt_at=?,lease_until=NULL,lease_token=NULL
    WHERE id=? AND status='sending' AND lease_token=?`,
    )
    .bind(
      accepted ? outcome : "pending",
      accepted ? now : null,
      Number(accepted),
      outcome,
      nextAttemptAt,
      id,
      token,
    )
    .run();
}
