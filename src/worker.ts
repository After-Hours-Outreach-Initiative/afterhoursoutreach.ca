import { handle } from "@astrojs/cloudflare/handler";
import {
  medicDeliveryCron,
  medicDiscoveryCron,
  processMedicCertificationNotifications,
} from "./server/medic-certifications";

export default {
  fetch: handle,
  async scheduled(controller, bindings) {
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
