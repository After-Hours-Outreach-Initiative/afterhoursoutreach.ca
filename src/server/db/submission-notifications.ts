import type { AuthBindings } from "../auth";
import {
  applicationSubmittedTemplate,
  emailSenders,
} from "../../data/email-templates";
import { emailHtmlSql, emailTextSql } from "./email-text";
import type { NaloxoneCompletionOptions } from "./naloxone";
import { emailPolicy } from "./policy";
import { emailBudgetKeys, emailBudgetSql } from "./rate-limits";
import { personDisplayNameSql } from "./sql";
import { buildMode, developmentBuild } from "../build-env";

// Rejected sends retry for less than a day after the first attempt. A send that
// may have been accepted is never retried: the provider has no idempotency keys.
export const submissionRetryWindowMs = 23 * 60 * 60 * 1000;
const leaseMs = 2 * 60 * 1000;

export function submissionNotificationMode(
  bindings: Pick<AuthBindings, "APP_ENV">,
) {
  if (buildMode() === "preview" || bindings.APP_ENV === "preview")
    return "preview";
  if (developmentBuild() || bindings.APP_ENV === "local") return "local";
  return bindings.APP_ENV === "production" ? "production" : "preview";
}

/** Called only inside the winning Naloxone confirmation D1 transaction.
 * Discord is temporarily disabled: form submission + Naloxone enter review.
 */
export function submissionNotificationStatements(
  bindings: AuthBindings,
): NonNullable<NaloxoneCompletionOptions["reviewStatements"]> {
  const mode = submissionNotificationMode(bindings);
  const values = {
    applicant: `replace(replace(${personDisplayNameSql({
      firstName: "json_extract(submitted_application,'$.answers.firstName')",
      lastName: "json_extract(submitted_application,'$.answers.lastName')",
      preferredName:
        "json_extract(submitted_application,'$.answers.preferredName')",
    })},char(13),' '),char(10),' ')`,
    reviewUrl: "?",
  };
  return ({ userId, operationId, writeGuard }) => [
    bindings.DB.prepare(
      `INSERT INTO application_submission_notification
        (id,operation_id,user_id,recipient,mode,payload,status,next_attempt_at,created_at)
      SELECT lower(hex(randomblob(16))),?,p.user_id,u.email,?,
        CASE WHEN ?='preview' THEN NULL ELSE json_object(
          'from',?, 'to',json_array(u.email),
          'subject',${emailTextSql(applicationSubmittedTemplate.subject, values)},
          'text',${emailTextSql(applicationSubmittedTemplate.text, values)},
          'html',${emailHtmlSql(applicationSubmittedTemplate.html, values)}
        ) END,?,p.naloxone_completed_at,p.naloxone_completed_at
      FROM profile p CROSS JOIN user u
        JOIN volunteer_status organizer_status ON organizer_status.user_id=u.id
      WHERE p.user_id=? AND p.submitted_application IS NOT NULL
        AND p.naloxone_completed_at IS NOT NULL AND ${writeGuard}
        AND u.role='organizer' AND u.email_verified=1 AND u.deleted_at IS NULL
        AND u.application_review_emails=1 AND organizer_status.active=1
        AND EXISTS (SELECT 1 FROM volunteer_status v WHERE v.user_id=p.user_id
          AND v.registration_approved=0 AND v.application_rejection_reason IS NULL)
      ON CONFLICT(user_id,recipient) DO NOTHING`,
    ).bind(
      operationId,
      mode,
      mode,
      emailSenders.notifications,
      `https://afterhoursoutreach.ca/applications/${encodeURIComponent(userId)}`,
      `https://afterhoursoutreach.ca/applications/${encodeURIComponent(userId)}`,
      mode === "preview" ? "suppressed" : "pending",
      userId,
      operationId,
    ),
  ];
}

export interface SubmissionNotification {
  id: string;
  payload: string;
  attempts: number;
  first_attempt_at: number | null;
}

const subscribedRecipientGuard = `EXISTS (SELECT 1 FROM user u
  JOIN volunteer_status v ON v.user_id=u.id
  WHERE u.email=application_submission_notification.recipient
    AND u.role='organizer' AND u.email_verified=1 AND u.deleted_at IS NULL
    AND u.application_review_emails=1 AND v.active=1)`;

// Provenance distinguishes review intents from the old initial-form outbox,
// including legacy applicants already ready for review. Never sweep/backfill
// those old messages. Retain every recipient's ledger/key as a dedupe tombstone.
const reviewIntentGuard = `EXISTS (SELECT 1 FROM audit_log a
  JOIN profile p ON p.user_id=a.subject_id
  WHERE a.id=application_submission_notification.operation_id
    AND a.subject_id=application_submission_notification.user_id
    AND a.action='profile_updated' AND a.changed_fields='["naloxoneCompletedAt"]'
    AND p.naloxone_completed_at IS NOT NULL)`;

export async function pendingSubmissionNotifications(
  db: Env["DB"],
  mode: "production" | "local",
  now: number,
  limit: number,
  operationId?: string,
) {
  // Retain terminal ledger rows. Unattempted mail does not expire during quota
  // or configuration outages; only an actual attempt starts the safety clock.
  await db
    .prepare(
      `UPDATE application_submission_notification
      SET status='suppressed',lease_until=NULL,lease_token=NULL
      WHERE mode=? AND status IN ('pending','sending') AND (NOT (${reviewIntentGuard}) OR NOT (${subscribedRecipientGuard}))`,
    )
    .bind(mode)
    .run();
  // A lapsed lease means a send may have been accepted before the run stopped.
  const [abandoned, expiration] = await db.batch([
    db
      .prepare(
        `UPDATE application_submission_notification
      SET status='expired',outcome='unconfirmed',lease_until=NULL,lease_token=NULL
      WHERE mode=? AND status='sending' AND lease_until <= ?`,
      )
      .bind(mode, now),
    db
      .prepare(
        `UPDATE application_submission_notification SET status='expired',lease_until=NULL
      WHERE mode=? AND status='pending' AND first_attempt_at <= ?`,
      )
      .bind(mode, now - submissionRetryWindowMs),
  ]);
  const result = await db
    .prepare(
      `SELECT id FROM application_submission_notification
    WHERE mode=? AND status='pending' AND next_attempt_at <= ?
      AND (first_attempt_at IS NULL OR first_attempt_at > ?)
      AND ${reviewIntentGuard} AND ${subscribedRecipientGuard}
      ${operationId ? "AND operation_id=?" : ""}
    ORDER BY next_attempt_at,created_at,id LIMIT ?`,
    )
    .bind(
      mode,
      now,
      now - submissionRetryWindowMs,
      ...(operationId ? [operationId] : []),
      limit,
    )
    .all<{ id: string }>();
  return {
    notifications: result.results,
    expired: abandoned.meta.changes + expiration.meta.changes,
  };
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
      lease_token=?,lease_until=?
    WHERE id=? AND mode=? AND status='pending' AND next_attempt_at <= ?
      AND (first_attempt_at IS NULL OR first_attempt_at > ?)
      AND ${reviewIntentGuard} AND ${subscribedRecipientGuard}
    RETURNING id,payload,attempts,first_attempt_at`,
    )
    .bind(token, now + leaseMs, id, mode, now, now - submissionRetryWindowMs)
    .first<SubmissionNotification>();
}

/** Reserve the SAME shared sign-in/event budget atomically with the outbox mark.
 * A same-window retry of a rejected send reuses its reservation; a new UTC day
 * reserves again. A crash cannot consume quota without recording it.
 */
export async function beginSubmissionNotificationAttempt(
  bindings: AuthBindings,
  id: string,
  token: string,
  now: number,
) {
  const { start, key, recent, expiresAt } = await emailBudgetKeys(
    bindings.BETTER_AUTH_SECRET,
    now,
  );
  const db = bindings.DB;
  const results = await db.batch([
    db
      .prepare(
        emailBudgetSql(`EXISTS (SELECT 1 FROM application_submission_notification
        WHERE id=? AND status='sending' AND mode='production' AND lease_token=?
          AND lease_until > ? AND budget_window IS NOT ?
          AND (first_attempt_at IS NULL OR first_attempt_at > ?)
          AND ${reviewIntentGuard} AND ${subscribedRecipientGuard})`),
      )
      .bind(
        key,
        1,
        expiresAt,
        id,
        token,
        now,
        start,
        now - submissionRetryWindowMs,
        1,
        recent,
        emailPolicy.rollingLimit,
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
        AND ${reviewIntentGuard} AND ${subscribedRecipientGuard}
      RETURNING id,payload,attempts,first_attempt_at`,
      )
      .bind(now, id, token, now, start, now - submissionRetryWindowMs),
  ]);
  return (results[2].results[0] as SubmissionNotification | undefined) ?? null;
}

/** An unconfirmed send is final: retrying it could deliver a duplicate. */
export async function finishSubmissionNotification(
  db: Env["DB"],
  id: string,
  token: string,
  outcome: "sent" | "local" | "failed" | "unconfirmed" | null,
  now: number,
  nextAttemptAt: number,
) {
  const accepted = outcome === "sent" || outcome === "local";
  const status = accepted
    ? outcome
    : outcome === "unconfirmed"
      ? "expired"
      : "pending";
  await db
    .prepare(
      `UPDATE application_submission_notification SET status=?,sent_at=?,
      outcome=CASE WHEN ?=1 THEN NULL WHEN outcome='unconfirmed' THEN outcome ELSE coalesce(?,outcome) END,
      next_attempt_at=?,lease_until=NULL,lease_token=NULL
    WHERE id=? AND status='sending' AND lease_token=?`,
    )
    .bind(
      status,
      accepted ? now : null,
      Number(accepted),
      outcome,
      nextAttemptAt,
      id,
      token,
    )
    .run();
}
