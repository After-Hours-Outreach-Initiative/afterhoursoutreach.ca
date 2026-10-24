import type { AuthBindings } from "./auth";
import { emailPolicy } from "./db/policy";
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

function retryAfter(response: Response, now: number) {
  const value = response.headers.get("Retry-After");
  if (!value) return 0;
  const milliseconds = /^\d+$/.test(value)
    ? Number(value) * 1000
    : Date.parse(value) - now;
  return Number.isFinite(milliseconds) ? Math.max(0, milliseconds) : 0;
}

/** Bounded automatic drain of this outbox ONLY, never event/access consent mail.
 * Each recipient has an independent frozen request/key and lease. Once accepted,
 * that recipient is never retried, even when a sibling recipient is failing.
 */
export async function deliverSubmissionNotifications(
  bindings: AuthBindings,
  options: DeliveryOptions = {},
  fetcher: typeof fetch = fetch,
) {
  const mode = submissionNotificationMode(bindings);
  // Both build-time and runtime checks: even a misbound preview must not send.
  if (mode === "preview") return { skipped: true };
  if (
    mode === "production" &&
    (!bindings.RESEND_API_KEY || !bindings.BETTER_AUTH_SECRET)
  )
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
    // Conservative pacing also accommodates older 2 request/second accounts.
    // Concurrent auth/event mail can still receive 429; persist Retry-After and
    // stop this run rather than hammering the provider's shared team limit.
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
      const response = await fetcher("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${bindings.RESEND_API_KEY}`,
          "Content-Type": "application/json",
          "User-Agent": "afterhoursoutreach.ca/1.0",
          "Idempotency-Key": `application-submission/${attempt.id}`,
        },
        signal: AbortSignal.any([
          deadline,
          AbortSignal.timeout(emailPolicy.timeoutMs),
        ]),
        body: attempt.payload,
      });
      // Never log or retain a provider body (including recipient-bearing errors).
      await response.body?.cancel();
      if (response.ok) {
        outcome = "sent"; // Provider acceptance, NOT confirmed inbox delivery.
        sent++;
      } else {
        // A 409 can mean the original request is still in progress; server
        // failures/timeouts may also have accepted mail. Always reuse the key.
        outcome =
          response.status >= 500 || response.status === 409
            ? "unconfirmed"
            : "failed";
        nextAttemptAt = Math.max(
          nextAttemptAt,
          Date.now() + retryAfter(response, Date.now()),
        );
        failed++;
        if (response.status === 429) {
          limited = true;
          break;
        }
      }
    } catch {
      outcome = requested ? "unconfirmed" : "failed";
      failed++;
    } finally {
      // Failure here deliberately leaves the lease in place. Recovery replays
      // this exact request/key only within the 23-hour safety window.
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
