import assert from "node:assert/strict";
import { test } from "vitest";
import { createTestHarness } from "wrangler";
import { createSignInOTP } from "../helpers/email-otp";

test("draft API enforces authentication, origin, ownership, revisions, and private resumption", async () => {
  const origin = "https://afterhoursoutreach.ca";
  const secret = "application-drafts-test-secret-12345678901234567890";
  const server = createTestHarness({
    workers: [
      {
        configPath: "dist/server/wrangler.json",
        vars: { APP_ENV: "production", AUTH_BASE_URL: origin },
        secrets: { BETTER_AUTH_SECRET: secret, RESEND_API_KEY: "" },
      },
    ],
  });
  try {
    await server.listen();
    const worker = server.getWorker<Env>();
    await worker.applyD1Migrations("DB");
    const { DB } = await worker.getEnv();
    const path = "/api/v1/account/application-draft";
    const send = (
      method = "GET",
      body?: object,
      cookie = "",
      requestOrigin = origin,
    ) =>
      worker.fetch(`${origin}${path}`, {
        method,
        headers: {
          origin: requestOrigin,
          cookie,
          "content-type": "application/json",
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    for (const method of ["GET", "PUT"])
      assert.equal(
        (await send(method, method === "PUT" ? {} : undefined)).status,
        401,
      );
    const proof = await createSignInOTP(DB, secret, "draft-api@example.org");
    const signedIn = await worker.fetch(
      `${origin}/api/v1/auth/sign-in/email-otp`,
      {
        method: "POST",
        headers: { origin, "content-type": "application/json" },
        body: JSON.stringify(proof),
      },
    );
    assert.equal(signedIn.status, 200);
    const cookie = signedIn.headers
      .getSetCookie()
      .filter((value) => !value.includes("Max-Age=0"))
      .map((value) => value.split(";")[0])
      .join("; ");
    const initial = await send("GET", undefined, cookie);
    const { userId, draft, submitted } = (await initial.json()) as {
      userId: string;
      draft: null;
      submitted: boolean;
    };
    assert.equal(draft, null);
    assert.equal(submitted, false);
    const body = {
      userId,
      version: 1,
      revision: null,
      answers: {
        firstName: "Draft",
        medicalConditions: "Private draft answer",
      },
    };
    assert.equal(
      (await send("PUT", body, cookie, "https://evil.example.org")).status,
      403,
    );
    assert.equal(
      (await send("PUT", { ...body, userId: "another-user" }, cookie)).status,
      403,
    );
    assert.equal(
      (
        await send(
          "PUT",
          { ...body, answers: { codeOfConductAccepted: true } },
          cookie,
        )
      ).status,
      400,
    );
    const saved = await send("PUT", body, cookie);
    assert.equal(saved.status, 200, await saved.clone().text());
    for (const header of ["cache-control", "x-robots-tag", "referrer-policy"])
      assert.equal(saved.headers.get(header), initial.headers.get(header));
    assert.equal(saved.headers.get("cache-control"), "no-store");
    assert.equal((await send("PUT", body, cookie)).status, 409);
    const resumed = await send("GET", undefined, cookie);
    assert.deepEqual(
      ((await resumed.json()) as { draft: unknown }).draft,
      ((await saved.json()) as { draft: unknown }).draft,
    );
    const page = await worker.fetch(`${origin}/apply`, {
      headers: { cookie },
      redirect: "manual",
    });
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /Private draft answer/);
    assert.match(html, /data-application-draft/);
    const firstName = html.match(/<input[^>]*name="firstName"[^>]*>/)?.[0];
    assert.ok(firstName);
    assert.match(firstName, /\brequired\b/);
    assert.equal(
      await DB.prepare("SELECT 1 FROM profile WHERE user_id=?")
        .bind(userId)
        .first(),
      null,
    );
  } finally {
    await server.close();
  }
});
