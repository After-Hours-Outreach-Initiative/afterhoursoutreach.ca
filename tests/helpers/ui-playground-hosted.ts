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
    for (const path of ["/dev/ui", "/dev/ui/discord?scenario=connected"]) {
      const response = await worker.fetch(`${origin}${path}`, {
        redirect: "manual",
      });
      assert.equal(response.status, 404, path);
    }
    const signIn = await worker.fetch(`${origin}/volunteer/sign-in`, {
      redirect: "manual",
    });
    assert.equal(signIn.status, 200);
    assert.doesNotMatch(await signIn.text(), /UI playground/);
  } finally {
    await server.close();
  }
}
