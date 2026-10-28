import assert from "node:assert/strict";
import { test } from "vitest";
import { createTestHarness } from "wrangler";
import { existsSync } from "node:fs";
import { chromium, expect } from "@playwright/test";
import { createSignInOTP } from "../helpers/email-otp";

test("self-service deletion requires fresh, confirmed same-origin authentication and preserves retained history", async () => {
  const origin = "https://afterhoursoutreach.ca";
  const secret = "account-deletion-test-secret-12345678901234567890";
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
    const send = (
      path: string,
      cookie = "",
      body?: object,
      site: string | null = origin,
    ) =>
      worker.fetch(origin + path, {
        method: body ? "POST" : "GET",
        redirect: "manual",
        headers: {
          cookie,
          "Content-Type": "application/json",
          ...(site ? { origin: site } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    const login = async (email: string) => {
      const signedIn = await send(
        "/api/v1/auth/sign-in/email-otp",
        "",
        await createSignInOTP(DB, secret, email),
      );
      assert.equal(signedIn.status, 200, await signedIn.clone().text());
      const cookie = signedIn.headers
        .getSetCookie()
        .filter((value) => !value.includes("Max-Age=0"))
        .map((value) => value.split(";")[0])
        .join("; ");
      const current = (await (
        await send("/api/v1/auth/get-session", cookie)
      ).json()) as { user: { id: string }; session: { id: string } };
      return {
        cookie,
        id: current.user.id,
        sessionId: current.session.id,
        email,
      };
    };
    const alice = await login("delete-alice@example.org");
    const otherDevice = await login(alice.email);
    const bob = await login("delete-bob@example.org");
    const confirmation = {
      userId: alice.id,
      email: alice.email,
      confirm: true,
    };
    const remove = (
      body: object,
      cookie = alice.cookie,
      site: string | null = origin,
    ) => send("/api/v1/account/delete", cookie, body, site);
    const accountPage = await send("/volunteer/account", alice.cookie);
    assert.equal(accountPage.status, 200); // Account deletion is available before applying too.
    assert.match(
      await accountPage.text(),
      /data-delete-account[\s\S]*Type your current email address to confirm/,
    );
    assert.equal((await remove(confirmation, "")).status, 401);
    assert.equal(
      (await remove(confirmation, alice.cookie, "https://evil.example")).status,
      403,
    );
    assert.equal((await remove(confirmation, alice.cookie, null)).status, 403);
    assert.equal(
      (await remove({ ...confirmation, confirm: false })).status,
      400,
    );
    assert.equal(
      (await remove({ ...confirmation, userId: bob.id })).status,
      409,
    );
    assert.equal(
      (await remove({ ...confirmation, email: bob.email })).status,
      409,
    );
    await DB.prepare("UPDATE session SET created_at=0 WHERE id=?")
      .bind(alice.sessionId)
      .run();
    assert.equal((await remove(confirmation)).status, 403);
    await DB.prepare("UPDATE session SET created_at=? WHERE id=?")
      .bind(Date.now(), alice.sessionId)
      .run();
    await DB.prepare("UPDATE user SET two_factor_enabled=1 WHERE id=?")
      .bind(alice.id)
      .run();
    assert.equal((await remove(confirmation)).status, 403);
    await DB.prepare("UPDATE user SET two_factor_enabled=0 WHERE id=?")
      .bind(alice.id)
      .run();

    await DB.prepare("UPDATE user SET role='organizer' WHERE id=?")
      .bind(bob.id)
      .run();
    for (const person of [alice, bob]) {
      await DB.prepare(
        `INSERT INTO profile (user_id,preferred_name,phone,birth_date,emergency_contact_name,emergency_contact_phone,
        emergency_contact_relationship,heard_about_us,motivation,teams,medical_certification,training_experience,registered_at,updated_at)
        VALUES (?,?,'555','2000-01-01','Contact','555','Friend','Friend','Help','[]','None','None',1,1)`,
      )
        .bind(person.id, person.email)
        .run();
      await DB.prepare(
        "INSERT INTO volunteer_status (user_id,registration_approved,updated_at) VALUES (?,1,1)",
      )
        .bind(person.id)
        .run();
    }
    await DB.batch([
      DB.prepare(
        "INSERT INTO application_draft (user_id,version,revision,answers,updated_at) VALUES (?,1,'revision','{}',1)",
      ).bind(alice.id),
      DB.prepare(
        "INSERT INTO account (id,user_id,account_id,provider_id,created_at,updated_at) VALUES ('credentials',?,?,'fixture',1,1)",
      ).bind(alice.id, alice.id),
      DB.prepare(
        "INSERT INTO two_factor (id,user_id,secret,backup_codes) VALUES ('factor',?,'fixture','fixture')",
      ).bind(alice.id),
      DB.prepare(
        "INSERT INTO audit_log (id,actor_id,subject_id,action,created_at) VALUES ('decision',?,?,'approval_changed',1)",
      ).bind(bob.id, alice.id),
      DB.prepare(
        "INSERT INTO event (id,type,starts_at,meeting_point,spots,created_by,created_at,updated_at) VALUES ('future','orientation',?,'Meeting point',8,?,1,1)",
      ).bind(Date.now() + 86_400_000, bob.id),
      DB.prepare(
        "INSERT INTO signup (id,event_id,user_id,created_at,updated_at) VALUES ('signup','future',?,1,1)",
      ).bind(alice.id),
      DB.prepare(
        "INSERT INTO discord_link (user_id,discord_id,username,guild_id,consented_at,join_token,next_attempt_at) VALUES (?,'200000000000000001','Linked name','100000000000000002',1,'ciphertext',0)",
      ).bind(alice.id),
      DB.prepare(
        "INSERT INTO event_notification_batch (id,operation_id,payload,status,lease_token,created_at) VALUES ('batch','operation','[]','sending','old-lease',?)",
      ).bind(Date.now()),
      DB.prepare(
        "INSERT INTO event_notification (id,operation_id,user_id,subject,body,batch_id,delivery_to,created_at) VALUES ('mail','operation',?,'Subject','Body','batch',?,?)",
      ).bind(alice.id, alice.email, Date.now()),
      DB.prepare(
        "INSERT INTO application_submission_notification (id,operation_id,user_id,recipient,mode,payload,next_attempt_at,created_at) VALUES ('submission','submission',?,'info@afterhoursoutreach.ca','production','{}',0,1)",
      ).bind(alice.id),
    ]);
    // Failure must not perform any of the cleanup, including for an organizer.
    const last = await remove(
      { userId: bob.id, email: bob.email, confirm: true },
      bob.cookie,
    );
    assert.equal(last.status, 409, await last.clone().text());
    assert.match(await last.text(), /at least one active organizer/);
    assert.equal(
      await DB.prepare("SELECT deleted_at FROM user WHERE id=?")
        .bind(bob.id)
        .first("deleted_at"),
      null,
    );
    // Exercise the actual client handler and keyboard-accessible confirmation,
    // routing every browser request to this isolated Worker, never the live site.
    const browser = await chromium.launch({
      executablePath:
        process.env.CHROMIUM_PATH ??
        (existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : undefined),
    });
    let deletionResponse: Awaited<ReturnType<typeof worker.fetch>> | undefined;
    try {
      const context = await browser.newContext();
      await context.addCookies(
        alice.cookie.split("; ").map((cookie) => {
          const split = cookie.indexOf("=");
          return {
            name: cookie.slice(0, split),
            value: cookie.slice(split + 1),
            url: origin,
            httpOnly: true,
            secure: true,
          };
        }),
      );
      const page = await context.newPage();
      await page.route("**/*", async (route) => {
        const request = route.request();
        if (!request.url().startsWith(origin)) return route.abort();
        const response = await worker.fetch(request.url(), {
          method: request.method(),
          headers: await request.allHeaders(),
          body: request.postData() ?? undefined,
          redirect: "manual",
        });
        if (request.url().endsWith("/api/v1/account/delete"))
          deletionResponse = response.clone();
        await route.fulfill({
          status: response.status,
          headers: Object.fromEntries(response.headers),
          body: Buffer.from(await response.arrayBuffer()),
        });
      });
      await page.goto(origin + "/volunteer/account");
      const review = page.getByText("Review account deletion", { exact: true });
      await review.focus();
      await review.press("Enter");
      await page
        .getByLabel("Type your current email address to confirm")
        .fill(alice.email);
      const button = page.getByRole("button", {
        name: "Permanently delete my account",
      });
      await button.click();
      assert.equal(deletionResponse, undefined); // Required checkbox blocks submission.
      await page
        .getByRole("checkbox", {
          name: /I understand this permanently deletes/,
        })
        .check();
      await button.focus();
      await button.press("Enter");
      await expect(page).toHaveURL(origin + "/volunteer/sign-in?deleted");
      await expect(
        page
          .getByRole("status")
          .filter({ hasText: "Your sign-in account has been deleted" }),
      ).toBeVisible();
    } finally {
      await browser.close();
    }
    const response = deletionResponse!;
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.ok(
      response.headers.getSetCookie().some((value) => /Max-Age=0/.test(value)),
    );
    assert.deepEqual(await response.json(), {
      next: "/volunteer/sign-in?deleted",
    });
    for (const table of [
      "session",
      "account",
      "two_factor",
      "application_draft",
      "discord_oauth",
    ])
      assert.equal(
        await DB.prepare(`SELECT count(*) n FROM ${table} WHERE user_id=?`)
          .bind(alice.id)
          .first("n"),
        0,
      );
    for (const cookie of [alice.cookie, otherDevice.cookie])
      assert.equal(
        await (await send("/api/v1/auth/get-session", cookie)).json(),
        null,
      );
    const tombstone = await DB.prepare(
      "SELECT name,email,email_verified,deleted_at FROM user WHERE id=?",
    )
      .bind(alice.id)
      .first<{
        name: string;
        email: string;
        email_verified: number;
        deleted_at: number;
      }>();
    assert.equal(tombstone!.name, "Deleted account");
    assert.match(tombstone!.email, /@account\.invalid$/);
    assert.equal(tombstone!.email_verified, 0);
    assert.ok(tombstone!.deleted_at);
    assert.equal(
      (
        await send("/api/v1/auth/sign-in/email-otp", "", {
          email: tombstone!.email,
          otp: "123456",
        })
      ).status,
      400,
    );
    assert.equal(
      await DB.prepare("SELECT phone FROM profile WHERE user_id=?")
        .bind(alice.id)
        .first("phone"),
      "555",
    );
    assert.equal(
      await DB.prepare("SELECT active FROM volunteer_status WHERE user_id=?")
        .bind(alice.id)
        .first("active"),
      0,
    );
    assert.equal(
      await DB.prepare("SELECT status FROM signup WHERE id='signup'").first(
        "status",
      ),
      "cancelled",
    );
    assert.ok(
      await DB.prepare("SELECT id FROM audit_log WHERE id='decision'").first(),
    );
    assert.equal(
      await DB.prepare(
        "SELECT status FROM event_notification_batch WHERE id='batch'",
      ).first("status"),
      "cancelled",
    );
    assert.equal(
      await DB.prepare(
        "SELECT lease_token FROM event_notification_batch WHERE id='batch'",
      ).first("lease_token"),
      null,
    );
    assert.equal(
      await DB.prepare(
        "SELECT status FROM application_submission_notification WHERE id='submission'",
      ).first("status"),
      "expired",
    );
    const discord = await DB.prepare(
      "SELECT join_token,observed_roles,next_attempt_at FROM discord_link WHERE user_id=?",
    )
      .bind(alice.id)
      .first();
    assert.deepEqual(discord, {
      join_token: null,
      observed_roles: null,
      next_attempt_at: 0,
    });
    await assert.rejects(
      DB.prepare(
        "INSERT INTO session (id,user_id,token,expires_at,created_at,updated_at) VALUES ('late',?,'late',?,1,1)",
      )
        .bind(alice.id, Date.now() + 1000)
        .run(),
      /account_deleted/,
    );
    const management = await send("/manage/volunteers", bob.cookie);
    assert.equal(management.status, 200);
    assert.doesNotMatch(await management.text(), new RegExp(alice.email));
    const replacement = await login(alice.email);
    assert.notEqual(replacement.id, alice.id);
    // Another active organizer permits deletion without erasing owned events.
    await DB.prepare(
      "INSERT INTO volunteer_status (user_id,updated_at) VALUES (?,1)",
    )
      .bind(replacement.id)
      .run();
    await DB.prepare("UPDATE user SET role='organizer' WHERE id=?")
      .bind(replacement.id)
      .run();
    const organizerDeleted = await remove(
      { userId: bob.id, email: bob.email, confirm: true },
      bob.cookie,
    );
    assert.equal(
      organizerDeleted.status,
      200,
      await organizerDeleted.clone().text(),
    );
    assert.equal(
      await DB.prepare("SELECT created_by FROM event WHERE id='future'").first(
        "created_by",
      ),
      bob.id,
    );
    assert.deepEqual(
      (await DB.prepare("PRAGMA foreign_key_check").all()).results,
      [],
    );
  } finally {
    await server.close();
  }
});
