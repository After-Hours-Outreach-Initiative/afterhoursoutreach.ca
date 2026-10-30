import assert from "node:assert/strict";
import { createTestHarness } from "wrangler";

export async function assertHostedUiPlaygroundAbsent(configPath: string) {
  const origin = "https://ui-playground-test.example.org";
  const server = createTestHarness({
    workers: [
      {
        configPath,
        vars: { AUTH_BASE_URL: origin },
        // Disable authentication: no credentials, sessions, or migrations needed.
        secrets: { BETTER_AUTH_SECRET: "", RESEND_API_KEY: "" },
      },
    ],
  });
  try {
    await server.listen();
    const worker = server.getWorker();
    for (const path of [
      "/dev/ui",
      "/dev/ui/discord?scenario=connected",
      "/dev/ui/event-card",
      "/dev/ui/event-card/preview?scenario=full",
      "/dev/ui/organizer-profile",
      "/dev/ui/organizer-profile/preview?scenario=organizer",
    ]) {
      const response = await worker.fetch(`${origin}${path}`, {
        redirect: "manual",
      });
      assert.equal(response.status, 404, path);
    }
    for (const path of ["/", "/about", "/volunteer/sign-in"]) {
      const response = await worker.fetch(`${origin}${path}`, {
        redirect: "manual",
      });
      assert.equal(response.status, 200, path);
      assert.doesNotMatch(
        await response.text(),
        /UI playground|DEV panel|data-account-switcher/,
        path,
      );
    }
  } finally {
    await server.close();
  }
}
