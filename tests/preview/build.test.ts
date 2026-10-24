import assert from "node:assert/strict";
import { test } from "vitest";
import { createTestHarness } from "wrangler";
import {
  previewEventFixtures,
  previewEventId,
} from "../../scripts/preview-event-fixtures";

test("preview builds support real account features but reject development endpoints", async () => {
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
      const home = await worker.fetch(origin);
      assert.equal(home.status, 200);
      assert.match(
        await home.text(),
        /<aside\b[^>]*aria-label="Preview environment"/,
      );
      assert.equal(home.headers.get("cache-control"), "no-store");
      const page = await worker.fetch(`${origin}/volunteer`);
      assert.equal(page.status, 200);
      assert.match(
        await page.text(),
        /<aside\b[^>]*aria-label="Preview environment"/,
      );
      assert.match(
        page.headers.get("content-security-policy")!,
        /script-src 'self'/,
      );
      const profile = await worker.fetch(`${origin}/api/v1/account/profile`, {
        method: "POST",
        headers: { origin, "content-type": "application/json" },
        body: "{}",
      });
      assert.equal(profile.status, 401);
      const session = await worker.fetch(`${origin}/api/v1/auth/get-session`);
      assert.equal(session.status, 200);
      assert.equal(await session.json(), null);
      const legacy = await worker.fetch(`${origin}/patrols`, {
        redirect: "manual",
      });
      assert.equal(legacy.status, 302);
      assert.equal(legacy.headers.get("location"), "/volunteer");
      assert.equal(
        (await worker.fetch(`${origin}/api/v1/auth/dev/users`)).status,
        404,
      );
      const switchUser = await worker.fetch(
        `${origin}/api/v1/auth/dev/switch-user`,
        {
          method: "POST",
          headers: { origin, "content-type": "application/json" },
          body: JSON.stringify({ userId: null }),
        },
      );
      assert.equal(switchUser.status, 404);
      const deletion = await worker.fetch(
        `${origin}/api/v1/auth/dev/delete-user`,
        {
          method: "POST",
          headers: { origin, "content-type": "application/json" },
          body: JSON.stringify({ userId: "new-application", confirm: true }),
        },
      );
      assert.equal(deletion.status, 404);
      const shortcut = await worker.fetch(
        `${origin}/api/v1/auth/dev/application-step`,
        {
          method: "POST",
          headers: { origin, "content-type": "application/json" },
          body: JSON.stringify({ userId: "new-application", step: "review" }),
        },
      );
      assert.equal(shortcut.status, 404);
    }
    const { DB } = await worker.getEnv();
    await DB.batch(previewEventFixtures().map((sql) => DB.prepare(sql)));
    const seeded = await worker.fetch(
      "https://feature-login-afterhoursoutreach-ca.ivanzheng9905.workers.dev/volunteer",
    );
    assert.equal(seeded.status, 200);
    const listing = await seeded.text();
    assert.equal((listing.match(/data-live-event=/g) ?? []).length, 0);
    assert.doesNotMatch(
      listing,
      /\[Sample\] Strathcona Community Centre|\[Sample\] Lord Strathcona Elementary School/,
    );
    assert.doesNotMatch(
      listing,
      new RegExp(previewEventId("hidden-orientation")),
    );
    assert.equal(
      (await DB.prepare("SELECT count(*) AS n FROM profile").first<{
        n: number;
      }>())!.n,
      6,
    );
    assert.equal(
      (await DB.prepare("SELECT count(*) AS n FROM event_notification").first<{
        n: number;
      }>())!.n,
      0,
    );
  } finally {
    await server.close();
  }
});
