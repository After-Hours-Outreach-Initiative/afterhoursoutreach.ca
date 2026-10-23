import {
  emailSenders,
  eventNotificationEmail,
} from "../../data/email-templates";

// Stay inside Resend's 24-hour idempotency lifetime, including after a timeout.
export const notificationRetryHours = 23;
const retryWindowMs = notificationRetryHours * 60 * 60 * 1000;
const leaseMs = 60 * 1000;

export interface EventEmail {
  id: string;
  to: string;
  subject: string;
  body: string;
  created_at: number;
}
export interface NotificationBatch {
  id: string;
  payload: string;
  budget_window: number | null;
}

export function queueNotification(
  db: Env["DB"],
  operation: string,
  userId: string,
  subject: string,
  body: string,
) {
  return db
    .prepare(
      `INSERT INTO event_notification (id, operation_id, user_id, subject, body, created_at, delivery_to)
    SELECT ?, ?, id, ?, ?, ?, email FROM user WHERE id=? AND email_verified=1`,
    )
    .bind(crypto.randomUUID(), operation, subject, body, Date.now(), userId);
}

export async function countNotifications(db: Env["DB"], operation: string) {
  const cutoff = Date.now() - retryWindowMs;
  const counts = await db
    .prepare(
      `SELECT
    count(CASE WHEN n.status IN ('sent','local') THEN 1 END) AS sent,
    count(CASE WHEN n.status = 'local' THEN 1 END) AS simulated,
    count(CASE WHEN n.status IN ('pending','sending') AND coalesce(b.created_at,n.created_at) > ? AND delivery_to IS NOT NULL THEN 1 END) AS pending,
    count(CASE WHEN n.status IN ('pending','sending') AND (coalesce(b.created_at,n.created_at) <= ? OR delivery_to IS NULL) THEN 1 END) AS expired
    FROM event_notification n LEFT JOIN event_notification_batch b ON b.id=n.batch_id WHERE n.operation_id=?`,
    )
    .bind(cutoff, cutoff, operation)
    .first<{
      sent: number;
      simulated: number;
      pending: number;
      expired: number;
    }>();
  return counts ?? { sent: 0, simulated: 0, pending: 0, expired: 0 };
}

export async function pendingNotifications(db: Env["DB"], operation: string) {
  const rows = await db
    .prepare(
      `SELECT id, delivery_to AS "to", subject, body, created_at FROM event_notification
    WHERE operation_id=? AND batch_id IS NULL AND delivery_to IS NOT NULL
    AND status='pending' AND created_at > ? ORDER BY created_at, id LIMIT 100`,
    )
    .bind(operation, Date.now() - retryWindowMs)
    .all<EventEmail>();
  return rows.results;
}

/** Transactional membership prevents two concurrent requests grouping the same mail. */
export async function createNotificationBatch(
  db: Env["DB"],
  operation: string,
  emails: EventEmail[],
  origin: string,
) {
  const id = crypto.randomUUID();
  const ids = JSON.stringify(emails.map((email) => email.id));
  const payload = JSON.stringify(
    emails.map((email) => ({
      from: emailSenders.notifications,
      to: [email.to],
      ...eventNotificationEmail(
        { subject: email.subject, text: email.body },
        origin,
      ),
    })),
  );
  const results = await db.batch([
    db
      .prepare(
        `INSERT INTO event_notification_batch (id, operation_id, payload, created_at)
      SELECT ?, ?, ?, ? WHERE (SELECT count(*) FROM event_notification
        WHERE id IN (SELECT value FROM json_each(?)) AND batch_id IS NULL AND operation_id=?) = ?`,
      )
      .bind(
        id,
        operation,
        payload,
        Math.min(...emails.map((email) => email.created_at)),
        ids,
        operation,
        emails.length,
      ),
    db
      .prepare(
        `UPDATE event_notification SET batch_id=?, delivery_origin=?
      WHERE id IN (SELECT value FROM json_each(?)) AND EXISTS(SELECT 1 FROM event_notification_batch WHERE id=?)`,
      )
      .bind(id, origin, ids, id),
  ]);
  return results[0].meta.changes ? id : null;
}

export async function pendingBatches(db: Env["DB"], operation: string) {
  const rows = await db
    .prepare(
      `SELECT id FROM event_notification_batch
    WHERE operation_id=? AND status IN ('pending','sending') AND created_at > ? ORDER BY created_at, id`,
    )
    .bind(operation, Date.now() - retryWindowMs)
    .all<{ id: string }>();
  return rows.results;
}

export function claimBatch(db: Env["DB"], id: string, token: string) {
  const now = Date.now();
  return db
    .prepare(
      `UPDATE event_notification_batch SET status='sending', outcome=CASE WHEN status='sending' THEN 'unconfirmed' ELSE outcome END, lease_token=?, lease_until=?
    WHERE id=? AND status IN ('pending','sending') AND (lease_until IS NULL OR lease_until < ?)
    AND created_at > ? RETURNING id, payload, budget_window`,
    )
    .bind(token, now + leaseMs, id, now, now - retryWindowMs)
    .first<NotificationBatch>();
}

export async function finishBatch(
  db: Env["DB"],
  id: string,
  token: string,
  outcome: "sent" | "local" | "failed" | "unconfirmed" | null,
) {
  const accepted = outcome === "sent" || outcome === "local";
  await db.batch([
    db
      .prepare(
        `UPDATE event_notification_batch SET status=?, outcome=CASE WHEN ?=1 THEN NULL WHEN outcome='unconfirmed' THEN outcome ELSE coalesce(?,outcome) END, lease_until=NULL
      WHERE id=? AND lease_token=?`,
      )
      .bind(
        accepted ? outcome : "pending",
        Number(accepted),
        outcome,
        id,
        token,
      ),
    db
      .prepare(
        `UPDATE event_notification SET status=?, sent_at=?, attempts=attempts+1
      WHERE batch_id=? AND EXISTS(SELECT 1 FROM event_notification_batch WHERE id=? AND lease_token=?)`,
      )
      .bind(
        accepted ? outcome : "pending",
        accepted ? Date.now() : null,
        id,
        id,
        token,
      ),
  ]);
}

export function markBatchBudget(
  db: Env["DB"],
  id: string,
  token: string,
  start: number,
) {
  return db
    .prepare(
      "UPDATE event_notification_batch SET budget_window=? WHERE id=? AND lease_token=?",
    )
    .bind(start, id, token)
    .run();
}

export async function uncertainNotifications(db: Env["DB"], operation: string) {
  return (
    (await db
      .prepare(
        `SELECT count(*) AS n FROM event_notification n JOIN event_notification_batch b ON b.id=n.batch_id
    WHERE n.operation_id=? AND n.status IN ('pending','sending') AND (b.outcome='unconfirmed' OR b.status='sending')`,
      )
      .bind(operation)
      .first<number>("n")) ?? 0
  );
}
