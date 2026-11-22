import type { AuthBindings } from "./auth";
import { emailSenders, medicCertificationEmail } from "../data/email-templates";
import { takeEmailBudget } from "./db/rate-limits";
import { sendEmail, type EmailPayload, type EmailSender } from "./email";
import {
  claimMedicNotification,
  countMedicNotifications,
  finishMedicNotification,
  pendingMedicNotifications,
  queueMedicCertificationNotifications,
  type MedicNotification,
} from "./db/medic-certifications";
import { buildMode, developmentBuild } from "./build-env";

export const medicDiscoveryCron = "0 16 * * *";
export const medicDeliveryCron = "30 * * * *";
const batchSize = 5;

function deliveryPayload(row: MedicNotification, origin: string) {
  return JSON.stringify(<EmailPayload>{
    from: emailSenders.notifications,
    to: [row.email],
    ...medicCertificationEmail(row.kind, row.expiry, origin),
  });
}

/** Production-only cron work. Development/preview runs must not send or consume mail. */
export async function processMedicCertificationNotifications(
  bindings: AuthBindings,
  discover: boolean,
  sender: EmailSender | undefined = bindings.EMAIL,
  now = Date.now(),
) {
  if (
    developmentBuild() ||
    buildMode() === "preview" ||
    bindings.APP_ENV !== "production"
  )
    return { skipped: true };
  if (!sender || !bindings.BETTER_AUTH_SECRET || !bindings.AUTH_BASE_URL)
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
    // Same pacing and shared quota as the other notification email.
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
    const outcome = await sendEmail(
      sender,
      JSON.parse(claimed.delivery_payload) as EmailPayload,
    );
    await finishMedicNotification(db, row.id, token, outcome, now);
    if (outcome === "sent") sent++;
    else failed++;
    if (outcome === "limited") break;
  }
  return { queued, sent, failed, ...(await countMedicNotifications(db)) };
}
