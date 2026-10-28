import { handle } from "@astrojs/cloudflare/handler";
import { discordCron } from "./server/discord/config";
import { runDiscordJob } from "./server/discord/sync";
import {
  runSubmissionNotificationJob,
  submissionDeliveryCron,
} from "./server/submission-notifications";
import {
  medicDeliveryCron,
  medicDiscoveryCron,
  processMedicCertificationNotifications,
} from "./server/medic-certifications";

export default {
  fetch: handle,
  async scheduled(controller, bindings) {
    if (controller.cron === discordCron) await runDiscordJob(bindings);
    // Independent catch-safe job: one notification family must not starve another.
    if (controller.cron === submissionDeliveryCron)
      await runSubmissionNotificationJob(bindings);
    if (![medicDiscoveryCron, medicDeliveryCron].includes(controller.cron))
      return;
    try {
      const result = await processMedicCertificationNotifications(
        bindings,
        controller.cron === medicDiscoveryCron,
      );
      console.log(
        JSON.stringify({
          event: "medic_certification_notifications",
          ...result,
        }),
      );
      if ("failed" in result && result.failed)
        throw new Error("Delivery failed");
    } catch {
      // Do not attach provider errors, profile answers, email addresses, or payloads.
      throw new Error(
        "Medic certification notification job failed; inspect aggregate counts and outbox state",
      );
    }
  },
} satisfies ExportedHandler<Env>;
