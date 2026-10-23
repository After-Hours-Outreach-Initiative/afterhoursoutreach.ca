import type { AuthBindings } from "./auth";
import { emailSenders, medicCertificationEmail } from "../data/email-templates";
import { emailPolicy } from "./db/policy";
import { takeEmailBudget } from "./db/rate-limits";
import {
  claimMedicNotification,
  countMedicNotifications,
  finishMedicNotification,
  pendingMedicNotifications,
  queueMedicCertificationNotifications,
  type MedicNotification,
} from "./db/medic-certifications";

export const medicDiscoveryCron = "0 16 * * *";
export const medicDeliveryCron = "30 * * * *";
const batchSize = 5;

function deliveryPayload(row: MedicNotification, origin: string) {
  return JSON.stringify({
    from: emailSenders.notifications,
    to: [row.email],
    ...medicCertificationEmail(row.kind, row.expiry, origin),
  });
}

/** Production-only cron work. Development/preview runs must not send or consume mail. */
export async function processMedicCertificationNotifications(
  bindings: AuthBindings,
  discover: boolean,
  fetcher: typeof fetch = fetch,
  now = Date.now(),
) {
  if (
    import.meta.env?.DEV ||
    import.meta.env?.MODE === "preview" ||
    bindings.APP_ENV !== "production"
  )
    return { skipped: true };
  if (
    !bindings.RESEND_API_KEY ||
    !bindings.BETTER_AUTH_SECRET ||
    !bindings.AUTH_BASE_URL
  )
    throw new Error("Medic certification email is not configured");
  const origin = new URL(bindings.AUTH_BASE_URL).origin;
  if (!origin.startsWith("https://"))
    throw new Error("Medic certification email requires HTTPS");
  const db = bindings.DB;
  const queued = discover
    ? await queueMedicCertificationNotifications(db, now)
    : 0;
  const rows = await pendingMedicNotifications(db, now, batchSize);
  let sent = 0;
  let failed = 0;
  for (const row of rows) {
    // Budget exhaustion must not start a provider retry clock for unsent mail.
    try {
      await takeEmailBudget(db, bindings.BETTER_AUTH_SECRET);
    } catch {
      failed++;
      break;
    }
    // Same pacing and shared quota as event notifications (Resend free tier).
    if (sent + failed > 0)
      await new Promise((resolve) => setTimeout(resolve, 600));
    const token = crypto.randomUUID();
    const claimed = await claimMedicNotification(
      db,
      row,
      deliveryPayload(row, origin),
      token,
      now,
    );
    if (!claimed) continue;
    try {
      const response = await fetcher("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${bindings.RESEND_API_KEY}`,
          "Content-Type": "application/json",
          "Idempotency-Key": `medic-certification/${row.id}`,
        },
        signal: AbortSignal.timeout(emailPolicy.timeoutMs),
        body: claimed.delivery_payload,
      });
      // Never read/log a provider body: it can contain recipient details.
      await response.body?.cancel();
      if (!response.ok) throw new Error("Provider rejected delivery");
      await finishMedicNotification(db, row.id, token, true, now);
      sent++;
    } catch {
      failed++;
      await finishMedicNotification(db, row.id, token, false, now);
    }
  }
  return { queued, sent, failed, ...(await countMedicNotifications(db)) };
}
