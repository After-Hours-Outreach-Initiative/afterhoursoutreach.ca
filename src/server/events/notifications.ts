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
} from "../db/notifications";
import { sendEmail, type EmailPayload, type EmailSender } from "../email";
import { buildMode, developmentBuild } from "../build-env";

/** Only an explicitly requested operation may be sent. Never sweep the outbox. */
export async function deliverNotifications(
  bindings: AuthBindings,
  operation: string,
  sender: EmailSender | undefined = bindings.EMAIL,
) {
  if (!operation) throw new Error("An email operation is required.");
  // Previews have no email binding; never send from one even if it is bound.
  if (buildMode() === "preview") sender = undefined;
  const db = bindings.DB;
  const local = developmentBuild() || bindings.APP_ENV === "local";
  // Each email is its own request; bound the whole run, not just one send.
  const deadline = Date.now() + 3 * emailPolicy.timeoutMs;
  let limited = false;
  let unavailable = false;
  let stopped = false;
  const sendBatch = async (id: string) => {
    const token = crypto.randomUUID();
    const batch = await claimBatch(db, id, token);
    if (!batch) return;
    // New batches hold one email. Older batches can hold several.
    const payload = JSON.parse(batch.payload) as EmailPayload[];
    let outcome: "sent" | "local" | "failed" | "unconfirmed" | null = null;
    let requested = false;
    try {
      if (!local) {
        if (!sender) {
          unavailable = true;
          outcome = "failed";
          stopped = true;
          return;
        }
        const start =
          Math.floor(Date.now() / emailPolicy.budgetWindowMs) *
          emailPolicy.budgetWindowMs;
        // Reserve emails, not calls. A same-day retry of a rejected send reuses
        // its reservation; crossing a budget window requires a fresh one.
        if (batch.budget_window !== start) {
          const reserved = await takeEmailBudget(
            db,
            bindings.BETTER_AUTH_SECRET,
            payload.length,
          );
          await markBatchBudget(db, id, token, reserved);
        }
        for (const [index, email] of payload.entries()) {
          if (Date.now() >= deadline) {
            outcome = index ? "unconfirmed" : null;
            stopped = true;
            return;
          }
          requested = true;
          const result = await sendEmail(
            sender,
            email,
            Math.min(emailPolicy.timeoutMs, deadline - Date.now()),
          );
          if (result === "sent") continue;
          if (result === "limited") limited = stopped = true;
          // Earlier emails in this batch were accepted: never resend them.
          outcome =
            index || result === "unconfirmed" ? "unconfirmed" : "failed";
          if (outcome === "unconfirmed") stopped = true;
          return;
        }
      }
      outcome = local ? "local" : "sent";
    } catch (error) {
      if (error instanceof RequestError && error.status === 429) limited = true;
      else outcome = requested ? "unconfirmed" : "failed";
      stopped = true;
    } finally {
      // If this write fails after acceptance, the lease lapses and the batch is
      // cancelled as unconfirmed, never sent again.
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
    // One email per batch: an unclear result affects only that recipient.
    const id = await createNotificationBatch(
      db,
      operation,
      rows.slice(0, local ? 100 : 1),
      bindings.AUTH_BASE_URL,
    );
    if (!id) break; // Another explicit request grouped these rows; do not race it.
    await sendBatch(id);
  }
  const counts = await countNotifications(db, operation);
  return { ...counts, limited, unavailable, failed: counts.pending };
}

export function notificationNotice(
  delivery: Awaited<ReturnType<typeof deliverNotifications>>,
) {
  // Successful delivery is silent; only problems need email-specific feedback.
  const parts: string[] = [];
  if (delivery.pending)
    parts.push(
      `${delivery.pending} email${delivery.pending === 1 ? " could" : "s could"} not be sent${delivery.limited ? " because of the shared email limit" : ""}.`,
      "Retry email only; the saved change will not be repeated. Retries are available for 23 hours after the change.",
    );
  if (delivery.unconfirmed)
    parts.push(
      `${delivery.unconfirmed} email${delivery.unconfirmed === 1 ? "" : "s"} may not have arrived and will not be resent, to avoid duplicates. Contact the recipients directly.`,
    );
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
