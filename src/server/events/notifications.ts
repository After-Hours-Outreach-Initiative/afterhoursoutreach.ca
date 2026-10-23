import type { AuthBindings } from "../auth";
import { emailBudgetRemaining, takeEmailBudget } from "../db/rate-limits";
import { emailPolicy } from "../db/policy";
import { RequestError } from "../http";
import {
  claimBatch,
  countNotifications,
  createNotificationBatch,
  finishBatch,
  markBatchBudget,
  pendingBatches,
  pendingNotifications,
  uncertainNotifications,
  type EventEmail,
} from "../db/notifications";

/** Only an explicitly requested operation may be sent. Never sweep the outbox. */
export async function deliverNotifications(
  bindings: AuthBindings,
  operation: string,
  fetcher: typeof fetch = fetch,
) {
  if (!operation) throw new Error("An email operation is required.");
  const db = bindings.DB;
  const local = Boolean(import.meta.env?.DEV) || bindings.APP_ENV === "local";
  const signal = AbortSignal.timeout(emailPolicy.timeoutMs);
  const emails: EventEmail[] = [];
  let limited = false;
  let unavailable = false;
  let stopped = false;
  const sendBatch = async (id: string) => {
    const token = crypto.randomUUID();
    const batch = await claimBatch(db, id, token);
    if (!batch) return;
    const payload = JSON.parse(batch.payload) as {
      to: string[];
      subject: string;
      text: string;
    }[];
    let outcome: "sent" | "local" | "failed" | "unconfirmed" | null = null;
    let requested = false;
    try {
      if (!local) {
        if (!bindings.RESEND_API_KEY) {
          unavailable = true;
          outcome = "failed";
          stopped = true;
          return;
        }
        const start =
          Math.floor(Date.now() / emailPolicy.budgetWindowMs) *
          emailPolicy.budgetWindowMs;
        // Reserve emails, not HTTP calls. A same-day idempotent replay costs no
        // additional emails; crossing a budget window requires a fresh reservation.
        if (batch.budget_window !== start) {
          const reserved = await takeEmailBudget(
            db,
            bindings.BETTER_AUTH_SECRET,
            payload.length,
          );
          await markBatchBudget(db, id, token, reserved);
        }
        signal.throwIfAborted();
        requested = true;
        const response = await fetcher("https://api.resend.com/emails/batch", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${bindings.RESEND_API_KEY}`,
            "Content-Type": "application/json",
            "Idempotency-Key": `event-batch/${batch.id}`,
          },
          signal,
          body: batch.payload,
        });
        if (!response.ok) {
          await response.body?.cancel();
          // Server errors / an in-progress idempotent request can be ambiguous.
          outcome =
            response.status >= 500 || response.status === 409
              ? "unconfirmed"
              : "failed";
          return;
        }
        const result = (await response.json()) as { data?: { id?: string }[] };
        // Default batch validation is atomic. A malformed/partial response is not
        // evidence that every email was accepted: replay the entire frozen key.
        if (
          !Array.isArray(result.data) ||
          result.data.length !== payload.length ||
          result.data.some((email) => !email.id)
        ) {
          outcome = "unconfirmed";
          return;
        }
      }
      outcome = local ? "local" : "sent";
      if (local)
        emails.push(
          ...payload.map((email, index) => ({
            id: `${id}/${index}`,
            to: email.to[0],
            subject: email.subject,
            body: email.text,
            created_at: Date.now(),
          })),
        );
    } catch (error) {
      if (error instanceof RequestError && error.status === 429) limited = true;
      else outcome = requested ? "unconfirmed" : "failed";
      if (signal.aborted || limited) stopped = true;
    } finally {
      // If this write fails after acceptance, the lease eventually expires and
      // an explicit retry replays the SAME payload/key, never a newly built batch.
      await finishBatch(db, id, token, outcome);
    }
  };
  for (const batch of await pendingBatches(db, operation)) {
    if (stopped) break;
    await sendBatch(batch.id);
  }
  while (!stopped) {
    const rows = await pendingNotifications(db, operation);
    if (!rows.length) break;
    const remaining = local
      ? 100
      : await emailBudgetRemaining(db, bindings.BETTER_AUTH_SECRET);
    if (!remaining) {
      limited = true;
      break;
    }
    const id = await createNotificationBatch(
      db,
      operation,
      rows.slice(0, Math.min(100, remaining)),
      bindings.AUTH_BASE_URL,
    );
    if (!id) break; // Another explicit request grouped these rows; do not race it.
    await sendBatch(id);
  }
  const counts = await countNotifications(db, operation);
  const unconfirmed = await uncertainNotifications(db, operation);
  return {
    ...counts,
    unconfirmed,
    limited,
    unavailable,
    failed: Math.max(0, counts.pending - unconfirmed),
    ...(import.meta.env?.DEV ? { localNotifications: emails } : {}),
  };
}

export function notificationNotice(
  delivery: Awaited<ReturnType<typeof deliverNotifications>>,
) {
  // Successful delivery is silent; only problems need email-specific feedback.
  const parts: string[] = [];
  if (delivery.pending) {
    if (delivery.unconfirmed)
      parts.push(
        `${delivery.unconfirmed} email${delivery.unconfirmed === 1 ? " has" : "s have"} unconfirmed delivery, possibly because the provider timed out.`,
      );
    if (delivery.failed)
      parts.push(
        `${delivery.failed} email${delivery.failed === 1 ? " could" : "s could"} not be sent${delivery.limited ? " because of the shared daily email limit" : ""}.`,
      );
    parts.push(
      "Retry email only; the saved change will not be repeated. Retries are available for 23 hours after the change.",
    );
  }
  if (delivery.expired)
    parts.push(
      `${delivery.expired} email${delivery.expired === 1 ? " is" : "s are"} no longer safe to retry. Contact the recipients directly.`,
    );
  return parts.join(" ");
}

/** A delivery/storage failure must never be reported as a failed committed write. */
export async function actionEmailResult(
  bindings: AuthBindings,
  result: { operation?: string; message: string },
  notify: boolean,
) {
  if (!notify || !result.operation)
    return {
      sent: 0,
      failed: 0,
      pending: 0,
      expired: 0,
      message: result.message,
    };
  try {
    const delivery = await deliverNotifications(bindings, result.operation);
    return {
      ...delivery,
      message: [result.message, notificationNotice(delivery)]
        .filter(Boolean)
        .join(" "),
      ...(delivery.pending ? { retryOperation: result.operation } : {}),
    };
  } catch {
    return {
      message: `${result.message} Email sending could not be confirmed. Retry email only; do not repeat the saved change.`,
      unconfirmed: 1,
      retryOperation: result.operation,
    };
  }
}
