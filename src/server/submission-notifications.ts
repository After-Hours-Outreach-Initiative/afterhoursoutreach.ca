import type { AuthBindings } from "./auth";
import { emailPolicy } from "./db/policy";
import { sendEmail, type EmailPayload, type EmailSender } from "./email";
import {
  beginSubmissionNotificationAttempt,
  claimSubmissionNotification,
  finishSubmissionNotification,
  pendingSubmissionNotifications,
  submissionNotificationMode,
} from "./db/submission-notifications";

// Reuse the existing hourly delivery trigger; no new bindings or remote setup.
export const submissionDeliveryCron = "30 * * * *";

interface DeliveryOptions {
  operationId?: string;
  limit?: number;
  timeoutMs?: number;
}

/** Bounded automatic drain of this outbox ONLY, never event/access consent mail.
 * Each recipient has an independent frozen request and lease. Once a send may
 * have been accepted, that recipient is never retried.
 */
export async function deliverSubmissionNotifications(
  bindings: AuthBindings,
  options: DeliveryOptions = {},
  sender: EmailSender | undefined = bindings.EMAIL,
) {
  const mode = submissionNotificationMode(bindings);
  // Both build-time and runtime checks: even a misbound preview must not send.
  if (mode === "preview") return { skipped: true };
  if (mode === "production" && (!sender || !bindings.BETTER_AUTH_SECRET))
    return { unavailable: true };
  const db = bindings.DB;
  const deadline = AbortSignal.timeout(options.timeoutMs ?? 60_000);
  let sent = 0;
  let simulated = 0;
  let failed = 0;
  let limited = false;
  let requests = 0;
  const { notifications, expired } = await pendingSubmissionNotifications(
    db,
    mode,
    Date.now(),
    options.limit ?? 6,
    options.operationId,
  );
  for (const row of notifications) {
    if (deadline.aborted) break;
    // Conservative pacing. Concurrent auth/event mail can still hit the
    // provider's rate limit; stop this run rather than hammering it.
    if (requests) await new Promise((resolve) => setTimeout(resolve, 600));
    if (deadline.aborted) break;
    const token = crypto.randomUUID();
    const claimed = await claimSubmissionNotification(
      db,
      row.id,
      mode,
      token,
      Date.now(),
    );
    if (!claimed) continue;
    let outcome: "sent" | "local" | "failed" | "unconfirmed" | null = null;
    let nextAttemptAt = Date.now() + 5 * 60_000;
    let requested = false;
    try {
      if (mode === "local") {
        outcome = "local";
        simulated++;
        continue;
      }
      const attempt = await beginSubmissionNotificationAttempt(
        bindings,
        row.id,
        token,
        Date.now(),
      );
      if (!attempt) {
        limited = true;
        // No request was made and no retry clock was started. Revisit after the
        // shared UTC budget resets (the hourly cron can pick up other mail).
        nextAttemptAt =
          (Math.floor(Date.now() / emailPolicy.budgetWindowMs) + 1) *
          emailPolicy.budgetWindowMs;
        break;
      }
      nextAttemptAt =
        Date.now() +
        Math.min(
          60 * 60_000,
          5 * 60_000 * 2 ** Math.min(attempt.attempts - 1, 4),
        );
      deadline.throwIfAborted();
      requested = true;
      requests++;
      const result = await sendEmail(
        sender!,
        JSON.parse(attempt.payload) as EmailPayload,
      );
      if (result === "sent") {
        outcome = "sent"; // Provider acceptance, NOT confirmed inbox delivery.
        sent++;
      } else {
        outcome = result === "unconfirmed" ? "unconfirmed" : "failed";
        failed++;
        if (result === "limited") {
          limited = true;
          break;
        }
      }
    } catch {
      outcome = requested ? "unconfirmed" : "failed";
      failed++;
    } finally {
      // Failure here deliberately leaves the lease in place. A lapsed lease is
      // treated as unconfirmed and never sent again.
      await finishSubmissionNotification(
        db,
        row.id,
        token,
        outcome,
        Date.now(),
        nextAttemptAt,
      );
    }
  }
  return { sent, simulated, failed, limited, expired };
}

/** Catch-safe for waitUntil AND scheduled delivery; never fail a committed save.
 * Logs contain aggregate counts/constant categories only, not IDs or payloads.
 */
export async function runSubmissionNotificationJob(
  bindings: AuthBindings,
  options: DeliveryOptions = {},
) {
  try {
    const result = await deliverSubmissionNotifications(bindings, options);
    console.log(
      JSON.stringify({
        event: "application_submission_notifications",
        ...result,
      }),
    );
    return result;
  } catch {
    console.error(
      JSON.stringify({
        event: "application_submission_notifications",
        error: "delivery_or_storage_unavailable",
      }),
    );
    return { failed: 1 };
  }
}
