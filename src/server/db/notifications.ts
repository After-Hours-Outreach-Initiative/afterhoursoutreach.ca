// Stay inside the provider's idempotency lifetime before retrying delivery.
export const notificationRetryHours = 23;
const retryWindowMs = notificationRetryHours * 60 * 60 * 1000;
const leaseMs = 60 * 1000;

export interface EventEmail {
  id: string;
  to: string;
  subject: string;
  body: string;
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
      "INSERT INTO event_notification (id, operation_id, user_id, subject, body, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(crypto.randomUUID(), operation, userId, subject, body, Date.now());
}

// Keep expired outbox records, but never describe them as retryable pending mail.
export async function countNotifications(db: Env["DB"], operation?: string) {
  const cutoff = Date.now() - retryWindowMs;
  const counts = await db
    .prepare(
      `SELECT
        count(CASE WHEN created_at > ? THEN 1 END) AS pending,
        count(CASE WHEN created_at <= ? THEN 1 END) AS expired
      FROM event_notification
      WHERE status IN ('pending', 'sending')
        ${operation ? "AND operation_id = ?" : ""}`,
    )
    .bind(cutoff, cutoff, ...(operation ? [operation] : []))
    .first<{ pending: number; expired: number }>();
  return counts ?? { pending: 0, expired: 0 };
}

export async function pendingNotifications(
  db: Env["DB"],
  limit: number,
  operation?: string,
) {
  const now = Date.now();
  const rows = await db
    .prepare(
      `SELECT n.id, u.email AS "to", n.subject, n.body FROM event_notification n
      JOIN user u ON u.id = n.user_id WHERE u.email_verified = 1
      AND (n.status = 'pending' OR (n.status = 'sending' AND n.lease_until < ?))
      AND n.created_at > ? ${operation ? "AND n.operation_id = ?" : ""} ORDER BY n.created_at LIMIT ?`,
    )
    .bind(now, now - retryWindowMs, ...(operation ? [operation] : []), limit)
    .all<EventEmail>();
  return rows.results;
}

/** Claim atomically and freeze the origin so concurrent retries use one payload. */
export function claimNotification(db: Env["DB"], id: string, origin: string) {
  const now = Date.now();
  return db
    .prepare(
      `UPDATE event_notification SET status = 'sending', lease_until = ?, attempts = attempts + 1, delivery_origin=coalesce(delivery_origin,?)
      WHERE id = ? AND (status = 'pending' OR (status = 'sending' AND lease_until < ?))
        AND created_at > ?
      RETURNING id, delivery_origin`,
    )
    .bind(now + leaseMs, origin, id, now, now - retryWindowMs)
    .first<{ id: string; delivery_origin: string }>();
}

export function recordNotificationDelivery(
  db: Env["DB"],
  id: string,
  local: boolean,
) {
  return db
    .prepare(
      "UPDATE event_notification SET status = ?, sent_at = ?, lease_until = NULL WHERE id = ?",
    )
    .bind(local ? "local" : "sent", Date.now(), id)
    .run();
}

export function releaseNotification(db: Env["DB"], id: string) {
  return db
    .prepare(
      "UPDATE event_notification SET status = 'pending', lease_until = NULL WHERE id = ?",
    )
    .bind(id)
    .run();
}
