import type { AuthBindings } from "../auth";
import { takeEmailBudget } from "../db/rate-limits";
import { emailPolicy } from "../db/policy";
import {
  claimNotification,
  countNotifications,
  pendingNotifications,
  recordNotificationDelivery,
  releaseNotification,
  type EventEmail,
} from "../db/notifications";
const providerDelayMs = 600;
const batchSize = 5;
const localBatchSize = 100;
const localConcurrency = 8;

export function notificationNotice(counts: {
  pending: number;
  expired: number;
}) {
  return (
    (counts.pending
      ? " Some notifications are awaiting delivery; an organizer can retry them."
      : "") +
    (counts.expired
      ? " Some notifications expired and cannot be retried; contact the recipients directly."
      : "")
  );
}

/** Leasing plus Resend idempotency prevents concurrent retries sending twice. */
export async function deliverNotifications(
  bindings: AuthBindings,
  operation?: string,
  fetcher: typeof fetch = fetch,
) {
  const db = bindings.DB;
  const local = Boolean(import.meta.env?.DEV) || bindings.APP_ENV === "local";
  const limit = local ? localBatchSize : batchSize;
  const concurrency = local ? localConcurrency : 1;
  const rows = await pendingNotifications(db, limit, operation);
  let failed = 0;
  let sent = 0;
  const emails: EventEmail[] = [];
  // Keep provider + D1 subrequests bounded, including on the free Worker plan.
  // Serialize provider requests; throttled attempts remain in the outbox.
  for (let offset = 0; offset < rows.length; offset += concurrency) {
    if (!local && bindings.RESEND_API_KEY && offset > 0)
      await new Promise((resolve) => setTimeout(resolve, providerDelayMs));
    await Promise.all(
      rows.slice(offset, offset + concurrency).map(async (email) => {
        const claimed = await claimNotification(
          db,
          email.id,
          bindings.AUTH_BASE_URL,
        );
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
          await recordNotificationDelivery(db, email.id, local);
          sent++;
          if (local) emails.push(email);
        } catch {
          failed++;
          await releaseNotification(db, email.id);
        }
      }),
    );
  }
  const counts = await countNotifications(db, operation);
  return {
    sent,
    failed,
    ...counts,
    ...(import.meta.env?.DEV ? { localNotifications: emails } : {}),
  };
}
