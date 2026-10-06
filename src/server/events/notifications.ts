import type { AuthBindings } from "../auth";
import { takeEmailBudget } from "../auth/abuse";
import { emailPolicy } from "../email-policy";

// Stay inside the provider's idempotency lifetime before retrying delivery.
export const notificationRetryHours = 23;
const retryWindowMs = notificationRetryHours * 60 * 60 * 1000;
const leaseMs = 60 * 1000;
const providerDelayMs = 600;
const batchSize = 5;
const localBatchSize = 100;
const localConcurrency = 8;

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

/** Leasing plus Resend idempotency prevents concurrent retries sending twice. */
export async function deliverNotifications(
  bindings: AuthBindings,
  operation?: string,
  fetcher: typeof fetch = fetch,
) {
  const db = bindings.DB;
  const now = Date.now();
  const local = Boolean(import.meta.env?.DEV) || bindings.APP_ENV === "local";
  const limit = local ? localBatchSize : batchSize;
  const concurrency = local ? localConcurrency : 1;
  const rows = await db
    .prepare(
      `SELECT n.id, u.email AS "to", n.subject, n.body FROM event_notification n
    JOIN user u ON u.id = n.user_id WHERE u.email_verified = 1
    AND (n.status = 'pending' OR (n.status = 'sending' AND n.lease_until < ?))
    AND n.created_at > ? ${operation ? "AND n.operation_id = ?" : ""} ORDER BY n.created_at LIMIT ?`,
    )
    .bind(now, now - retryWindowMs, ...(operation ? [operation] : []), limit)
    .all<EventEmail>();
  let failed = 0;
  let sent = 0;
  const emails: EventEmail[] = [];
  // Keep provider + D1 subrequests bounded, including on the free Worker plan.
  // Serialize provider requests; throttled attempts remain in the outbox.
  for (let offset = 0; offset < rows.results.length; offset += concurrency) {
    if (!local && bindings.RESEND_API_KEY && offset > 0)
      await new Promise((resolve) => setTimeout(resolve, providerDelayMs));
    await Promise.all(
      rows.results.slice(offset, offset + concurrency).map(async (email) => {
        const claimed = await db
          .prepare(
            `UPDATE event_notification SET status = 'sending', lease_until = ?, attempts = attempts + 1, delivery_origin=coalesce(delivery_origin,?)
        WHERE id = ? AND (status = 'pending' OR (status = 'sending' AND lease_until < ?)) RETURNING id, delivery_origin`,
          )
          .bind(
            Date.now() + leaseMs,
            bindings.AUTH_BASE_URL,
            email.id,
            Date.now(),
          )
          .first();
        if (!claimed) return;
        try {
          if (!local) {
            if (!bindings.RESEND_API_KEY)
              throw new Error("Unconfigured provider");
            await takeEmailBudget(db, bindings.BETTER_AUTH_SECRET);
            const response = await fetcher("https://api.resend.com/emails", {
              method: "POST",
              headers: {
                Authorization: `Bearer ${bindings.RESEND_API_KEY}`,
                "Content-Type": "application/json",
                "Idempotency-Key": `event/${email.id}`,
              },
              signal: AbortSignal.timeout(emailPolicy.timeoutMs),
              body: JSON.stringify({
                from: "After Hours Outreach <noreply@afterhoursoutreach.ca>",
                to: [email.to],
                subject: email.subject,
                text: `${email.body}\n\nEvents: ${claimed.delivery_origin}/volunteer`,
              }),
            });
            await response.body?.cancel();
            if (!response.ok) throw new Error("Provider rejected delivery");
          }
          await db
            .prepare(
              "UPDATE event_notification SET status = ?, sent_at = ?, lease_until = NULL WHERE id = ?",
            )
            .bind(local ? "local" : "sent", Date.now(), email.id)
            .run();
          sent++;
          if (local) emails.push(email);
        } catch {
          failed++;
          await db
            .prepare(
              "UPDATE event_notification SET status = 'pending', lease_until = NULL WHERE id = ?",
            )
            .bind(email.id)
            .run();
        }
      }),
    );
  }
  const remaining = await db
    .prepare(
      `SELECT count(*) AS count FROM event_notification WHERE status IN ('pending','sending') ${operation ? "AND operation_id=?" : ""}`,
    )
    .bind(...(operation ? [operation] : []))
    .first<{ count: number }>();
  return {
    sent,
    failed,
    pending: remaining?.count ?? 0,
    ...(import.meta.env?.DEV ? { localNotifications: emails } : {}),
  };
}
