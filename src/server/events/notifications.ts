import type { AuthBindings } from "../auth";
import { takeRateLimit } from "../auth/abuse";

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
  const rows = await db
    .prepare(
      `SELECT n.id, u.email AS "to", n.subject, n.body FROM event_notification n
    JOIN user u ON u.id = n.user_id WHERE u.email_verified = 1
    AND (n.status = 'pending' OR (n.status = 'sending' AND n.lease_until < ?))
    AND n.created_at > ? ${operation ? "AND n.operation_id = ?" : ""} ORDER BY n.created_at LIMIT ${local ? 100 : 5}`,
    )
    .bind(now, now - 23 * 3_600_000, ...(operation ? [operation] : []))
    .all<EventEmail>();
  let failed = 0;
  let sent = 0;
  const emails: EventEmail[] = [];
  // Keep provider + D1 subrequests bounded, including on the free Worker plan.
  // Serialize provider requests; throttled attempts remain in the outbox.
  for (let offset = 0; offset < rows.results.length; offset += local ? 8 : 1) {
    if (!local && bindings.RESEND_API_KEY && offset > 0)
      await new Promise((resolve) => setTimeout(resolve, 600));
    await Promise.all(
      rows.results
        .slice(offset, offset + (local ? 8 : 1))
        .map(async (email) => {
          const claimed = await db
            .prepare(
              `UPDATE event_notification SET status = 'sending', lease_until = ?, attempts = attempts + 1, delivery_origin=coalesce(delivery_origin,?)
        WHERE id = ? AND (status = 'pending' OR (status = 'sending' AND lease_until < ?)) RETURNING id, delivery_origin`,
            )
            .bind(
              Date.now() + 60_000,
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
              await takeRateLimit(
                db,
                bindings.BETTER_AUTH_SECRET,
                "send-total",
                80,
                86_400_000,
              );
              const response = await fetcher("https://api.resend.com/emails", {
                method: "POST",
                headers: {
                  Authorization: `Bearer ${bindings.RESEND_API_KEY}`,
                  "Content-Type": "application/json",
                  "Idempotency-Key": `event/${email.id}`,
                },
                signal: AbortSignal.timeout(10_000),
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
