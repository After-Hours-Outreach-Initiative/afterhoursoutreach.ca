import assert from "node:assert/strict";
import { test } from "vitest";
import { createTestHarness } from "wrangler";
import { createSignInOTP } from "../helpers/email-otp";
import { sampleAnswers } from "../helpers/local-account";

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
    for (const method of ["GET", "PUT", "DELETE"])
      assert.equal(
        (await send(method, method === "GET" ? undefined : {})).status,
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
    const original = (await saved.json()) as { draft: { revision: string } };
    assert.deepEqual(
      ((await resumed.json()) as { draft: unknown }).draft,
      original.draft,
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
    const discardBody = {
      userId,
      generation: null,
      discardId: crypto.randomUUID(),
    };
    assert.equal(
      (await send("DELETE", discardBody, cookie, "https://evil.example.org"))
        .status,
      403,
    );
    assert.equal(
      (
        await worker.fetch(`${origin}${path}`, {
          method: "DELETE",
          headers: { cookie, "content-type": "application/json" },
          body: JSON.stringify(discardBody),
        })
      ).status,
      403,
    );
    assert.equal(
      (await send("DELETE", { ...discardBody, userId: "another-user" }, cookie))
        .status,
      403,
    );
    for (const invalid of [
      {},
      { ...discardBody, discardId: "not-a-uuid" },
      { ...discardBody, answers: {} },
      { ...discardBody, userId: "x".repeat(1100) },
    ])
      assert.ok(
        [400, 413].includes((await send("DELETE", invalid, cookie)).status),
      );
    // Rejected deletions have not touched the saved answers.
    assert.match(
      await (await send("GET", undefined, cookie)).text(),
      /Private draft answer/,
    );

    await DB.prepare("UPDATE user SET two_factor_enabled=1 WHERE id=?")
      .bind(userId)
      .run();
    assert.equal((await send("DELETE", discardBody, cookie)).status, 401);
    assert.ok(
      await DB.prepare("SELECT 1 FROM application_draft WHERE user_id=?")
        .bind(userId)
        .first(),
    );
    await DB.prepare("UPDATE user SET two_factor_enabled=0 WHERE id=?")
      .bind(userId)
      .run();

    const deleted = await send("DELETE", discardBody, cookie);
    assert.equal(deleted.status, 200, await deleted.clone().text());
    assert.equal(deleted.headers.get("cache-control"), "no-store");
    assert.deepEqual(await deleted.json(), {
      userId,
      generation: discardBody.discardId,
    });
    assert.equal(
      await DB.prepare("SELECT 1 FROM application_draft WHERE user_id=?")
        .bind(userId)
        .first(),
      null,
    );
    assert.deepEqual(await (await send("GET", undefined, cookie)).json(), {
      userId,
      submitted: false,
      draft: null,
      generation: discardBody.discardId,
    });
    // Lost-response retries are idempotent; old null-revision and existing-row
    // writes must both be rejected after the answer row has been removed.
    assert.equal((await send("DELETE", discardBody, cookie)).status, 200);
    const previous = (await (await send("GET", undefined, cookie)).json()) as {
      generation: string;
    };
    assert.equal((await send("PUT", body, cookie)).status, 409);
    assert.equal(
      (
        await send(
          "PUT",
          { ...body, revision: original.draft.revision },
          cookie,
        )
      ).status,
      409,
    );
    const fresh = await send(
      "PUT",
      {
        ...body,
        generation: previous.generation,
        answers: { firstName: "New application" },
      },
      cookie,
    );
    assert.equal(fresh.status, 200, await fresh.clone().text());
    assert.equal((await send("DELETE", discardBody, cookie)).status, 409);
    assert.match(
      await (await send("GET", undefined, cookie)).text(),
      /New application/,
    );
    const freshDraft = ((await fresh.json()) as { draft: { revision: string } })
      .draft;
    const secondDiscard = {
      userId,
      generation: previous.generation,
      discardId: crypto.randomUUID(),
    };
    const [racedSave, racedDiscard] = await Promise.all([
      send(
        "PUT",
        {
          ...body,
          generation: previous.generation,
          revision: freshDraft.revision,
        },
        cookie,
      ),
      send("DELETE", secondDiscard, cookie),
    ]);
    assert.ok([200, 409].includes(racedSave.status));
    assert.equal(racedDiscard.status, 200);
    assert.equal(
      (
        (await (await send("GET", undefined, cookie)).json()) as {
          draft: unknown;
        }
      ).draft,
      null,
    );
    assert.equal(
      (
        await send(
          "PUT",
          { ...body, generation: previous.generation, revision: null },
          cookie,
        )
      ).status,
      409,
    );

    // A different real account cannot delete the owner's tombstone or answers.
    const otherProof = await createSignInOTP(
      DB,
      secret,
      "draft-other@example.org",
    );
    const otherSignIn = await worker.fetch(
      `${origin}/api/v1/auth/sign-in/email-otp`,
      {
        method: "POST",
        headers: { origin, "content-type": "application/json" },
        body: JSON.stringify(otherProof),
      },
    );
    const otherCookie = otherSignIn.headers
      .getSetCookie()
      .filter((value) => !value.includes("Max-Age=0"))
      .map((value) => value.split(";")[0])
      .join("; ");
    assert.equal(
      (await send("DELETE", secondDiscard, otherCookie)).status,
      403,
    );
    const other = (await (
      await send("GET", undefined, otherCookie)
    ).json()) as { userId: string };
    const otherBody = { ...body, userId: other.userId };
    const [firstSave, firstDiscard] = await Promise.all([
      send("PUT", otherBody, otherCookie),
      send(
        "DELETE",
        {
          ...discardBody,
          userId: other.userId,
          discardId: crypto.randomUUID(),
        },
        otherCookie,
      ),
    ]);
    assert.ok([200, 409].includes(firstSave.status));
    assert.equal(firstDiscard.status, 200);
    assert.equal(
      (
        (await (await send("GET", undefined, otherCookie)).json()) as {
          draft: unknown;
        }
      ).draft,
      null,
    );
    // Revoked sessions cannot advance generation or remove an unsubmitted copy.
    const otherState = (await (
      await send("GET", undefined, otherCookie)
    ).json()) as { generation: string };
    assert.equal(
      (
        await send(
          "PUT",
          { ...otherBody, generation: otherState.generation },
          otherCookie,
        )
      ).status,
      200,
    );
    await DB.prepare("DELETE FROM session WHERE user_id=?")
      .bind(other.userId)
      .run();
    assert.equal(
      (
        await send(
          "DELETE",
          {
            userId: other.userId,
            generation: otherState.generation,
            discardId: crypto.randomUUID(),
          },
          otherCookie,
        )
      ).status,
      401,
    );
    assert.ok(
      await DB.prepare("SELECT 1 FROM application_draft WHERE user_id=?")
        .bind(other.userId)
        .first(),
    );
    assert.equal(
      (
        await send(
          "DELETE",
          {
            ...secondDiscard,
            generation: secondDiscard.discardId,
            discardId: crypto.randomUUID(),
          },
          cookie,
        )
      ).status,
      200,
    );

    const submittedResponse = await worker.fetch(
      `${origin}/api/v1/account/profile`,
      {
        method: "POST",
        headers: { cookie, origin, "content-type": "application/json" },
        body: JSON.stringify({
          ...sampleAnswers,
          applicationUserId: userId,
          codeOfConductAccepted: true,
        }),
      },
    );
    assert.equal(
      submittedResponse.status,
      200,
      await submittedResponse.clone().text(),
    );
    const snapshot = await DB.prepare(
      "SELECT submitted_application FROM profile WHERE user_id=?",
    )
      .bind(userId)
      .first();
    assert.equal(
      (
        await send(
          "DELETE",
          { userId, generation: null, discardId: crypto.randomUUID() },
          cookie,
        )
      ).status,
      410,
    );
    assert.deepEqual(
      await DB.prepare(
        "SELECT submitted_application FROM profile WHERE user_id=?",
      )
        .bind(userId)
        .first(),
      snapshot,
    );
    assert.ok(
      await DB.prepare("SELECT 1 FROM user WHERE id=?").bind(userId).first(),
    );
    await DB.prepare("DELETE FROM session WHERE user_id=?").bind(userId).run();
    assert.equal((await send("DELETE", discardBody, cookie)).status, 401);
  } finally {
    await server.close();
  }
});
