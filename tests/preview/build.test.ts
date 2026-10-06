import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";
import { createTestHarness } from "wrangler";

test("the preview banner does not gate features or restrict accounts to preview hosts", async () => {
  const html = readFileSync(
    new URL("../../dist-preview/client/index.html", import.meta.url),
    "utf8",
  );
  assert.match(html, /Preview · public test site/);
  assert.match(html, /data-live-event-teaser/);
  assert.doesNotMatch(html, /data-patrol-list|data-account-switcher/);
  const chunks = readdirSync(
    new URL("../../dist-preview/client/_astro/", import.meta.url),
  );
  assert.ok(
    !chunks.some((name) =>
      /PatrolList|patrol-store|local-email-dialog|account-switcher/.test(name),
    ),
  );

  const server = createTestHarness({
    workers: [
      {
        configPath: "dist-preview/server/wrangler.json",
        vars: { APP_ENV: "preview", AUTH_BASE_URL: "" },
        secrets: {
          BETTER_AUTH_SECRET: "preview-test-secret-12345678901234567890",
          RESEND_API_KEY: "",
        },
      },
    ],
  });
  try {
    await server.listen();
    const worker = server.getWorker<Env>();
    await worker.applyD1Migrations("DB");
    for (const origin of [
      "https://feature-login-afterhoursoutreach-ca.ivanzheng9905.workers.dev",
      "https://custom-test.example.org",
    ]) {
      const page = await worker.fetch(`${origin}/volunteer`);
      assert.equal(page.status, 200);
      assert.match(await page.text(), /Preview · public test site/);
      assert.match(
        page.headers.get("content-security-policy")!,
        /script-src 'self'/,
      );
      const profile = await worker.fetch(`${origin}/api/account/profile`, {
        method: "POST",
        headers: { origin, "content-type": "application/json" },
        body: "{}",
      });
      assert.equal(profile.status, 401);
      const session = await worker.fetch(`${origin}/api/auth/get-session`);
      assert.equal(session.status, 200);
      assert.equal(await session.json(), null);
      const legacy = await worker.fetch(`${origin}/patrols`, {
        redirect: "manual",
      });
      assert.equal(legacy.status, 302);
      assert.equal(legacy.headers.get("location"), "/volunteer");
      assert.equal(
        (await worker.fetch(`${origin}/api/auth/dev/users`)).status,
        404,
      );
    }
  } finally {
    await server.close();
  }
});
