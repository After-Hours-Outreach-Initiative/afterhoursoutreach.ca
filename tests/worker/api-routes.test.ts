import assert from "node:assert/strict";
import { test } from "vitest";
import { createTestHarness } from "wrangler";

test("API routes use the v1 prefix and retain private headers on workers.dev", async () => {
  const origin =
    "https://api-routes-afterhoursoutreach-ca.ivanzheng9905.workers.dev";
  const server = createTestHarness({
    workers: [
      {
        configPath: "dist/server/wrangler.json",
        vars: { APP_ENV: "production", AUTH_BASE_URL: "" },
        secrets: {
          BETTER_AUTH_SECRET: "api-routes-test-secret-12345678901234567890",
          RESEND_API_KEY: "",
        },
      },
    ],
  });
  try {
    await server.listen();
    const worker = server.getWorker<Env>();
    await worker.applyD1Migrations("DB");
    for (const [path, method, status] of [
      ["health", "GET", 200],
      ["events", "GET", 200],
      ["auth/get-session", "GET", 200],
      ["account/profile", "POST", 401],
      ["account/session", "POST", 401],
      ["events/action", "POST", 401],
      ["organizer/action", "POST", 401],
    ] as const) {
      const options = {
        method,
        headers: { origin, "content-type": "application/json" },
        ...(method === "POST" ? { body: "{}" } : {}),
        redirect: "manual" as const,
      };
      const response = await worker.fetch(`${origin}/api/v1/${path}`, options);
      assert.equal(response.status, status, path);
      assert.equal(response.headers.get("cache-control"), "no-store", path);
      if (path === "health") {
        assert.deepEqual(await response.json(), { status: "ok" });
      } else {
        assert.equal(
          response.headers.get("x-robots-tag"),
          "noindex, nofollow, noarchive",
          path,
        );
        assert.equal(
          response.headers.get("referrer-policy"),
          "no-referrer",
          path,
        );
        assert.equal(
          response.headers.get("x-content-type-options"),
          "nosniff",
          path,
        );
        assert.match(
          response.headers.get("content-security-policy")!,
          /connect-src 'self'/,
          path,
        );
        if (path === "events")
          assert.deepEqual(await response.json(), { events: [] });
        if (path === "auth/get-session")
          assert.equal(await response.json(), null);
      }
      const legacy = await worker.fetch(`${origin}/api/${path}`, options);
      assert.equal(legacy.status, 404, `Unversioned route: ${path}`);
    }
  } finally {
    await server.close();
  }
});
