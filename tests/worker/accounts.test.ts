import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { test } from "node:test";
import { createTestHarness } from "wrangler";
import { chromium, type Page } from "@playwright/test";
import { createSignInOTP } from "../helpers/email-otp";
import { totpFromSetupKey } from "../helpers/totp";

const origin = "https://afterhoursoutreach.ca";
const secret = "test-only-worker-auth-secret-12345678901234567890";
async function assertAccountBackground(page: Page) {
  assert.deepEqual(
    await page.evaluate(() => ({
      header: getComputedStyle(document.querySelector("header")!)
        .backgroundColor,
      content: getComputedStyle(
        document.querySelector(".volunteer-wrap")!.parentElement!,
      ).backgroundColor,
    })),
    { header: "rgb(0, 0, 0)", content: "rgb(0, 0, 0)" },
  );
}
const answers = {
  name: "Worker Test Volunteer",
  pronouns: "they/them",
  phone: "604-555-0100",
  birthDate: "1995-04-12",
  emergencyName: "Sample Contact",
  emergencyPhone: "604-555-0101",
  emergencyRelationship: "Friend",
  heardAboutUs: "A friend",
  motivation: "Sample answer",
  teams: ["outreach"],
  certification: "None",
  experience: "None",
  medicalConditions: "Sample private answer",
};

test("production-built Worker enforces authentication, ownership, CSRF and private-page protections", async (t) => {
  const server = createTestHarness({
    workers: [
      {
        configPath: "dist/server/wrangler.json",
        vars: {
          APP_ENV: "production",
          AUTH_BASE_URL: origin,
        },
        secrets: {
          BETTER_AUTH_SECRET: secret,
          RESEND_API_KEY: "",
        },
      },
    ],
  });
  try {
    await server.listen();
    const worker = server.getWorker<Env>();
    await worker.applyD1Migrations("DB");
    const { DB, AUTH_BASE_URL } = await worker.getEnv();
    assert.equal(AUTH_BASE_URL, origin);
    const send = (
      path: string,
      body?: object,
      cookie?: string,
      requestOrigin = origin,
    ) =>
      worker.fetch(`${origin}${path}`, {
        method: body ? "POST" : "GET",
        headers: {
          origin: requestOrigin,
          "content-type": "application/json",
          ...(cookie ? { cookie } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        redirect: "manual",
      });
    await t.test(
      "site origins reject unrelated, preview and forwarded-host CSRF",
      async () => {
        for (const host of [
          "https://evil.example.org",
          "https://other-afterhoursoutreach-ca.ivanzheng9905.workers.dev",
        ]) {
          const response = await send(
            "/api/auth/email-otp/send-verification-otp",
            { email: "no-mail@example.org", type: "sign-in" },
            undefined,
            host,
          );
          assert.equal(response.status, 403);
        }
        const response = await worker.fetch(
          "https://evil.example.org/api/auth/get-session",
          { headers: { "x-forwarded-host": new URL(origin).hostname } },
        );
        assert.equal(response.status, 403);
      },
    );
    const signIn = async (email: string) => {
      const proof = await createSignInOTP(DB, secret, email);
      const response = await send("/api/auth/sign-in/email-otp", proof);
      assert.equal(response.status, 200, await response.clone().text());
      return response.headers
        .getSetCookie()
        .filter((cookie) => !cookie.includes("Max-Age=0"))
        .map((cookie) => cookie.split(";")[0])
        .join("; ");
    };

    await t.test(
      "unauthenticated profile access is rejected and registration redirects to sign-in",
      async () => {
        const profile = await send("/api/account/profile", answers);
        assert.equal(profile.status, 401, await profile.clone().text());
        const register = await send("/volunteer/register");
        assert.equal(register.status, 302);
        assert.match(register.headers.get("location")!, /sign-in/);
        assert.equal((await send("/api/auth/sign-in/email-otp")).status, 405);
        assert.equal(
          (await send("/api/auth/email-otp/get-verification-otp")).status,
          404,
        );
        assert.equal(
          (await send("/api/auth/email-otp/check-verification-otp", {})).status,
          404,
        );
        assert.equal(
          (await send("/api/auth/update-user", { name: "Attacker" })).status,
          404,
        );
        assert.equal(
          (await send("/api/auth/two-factor/disable", {})).status,
          404,
        );
        assert.equal((await send("/api/auth/dev/users")).status, 404);
        assert.equal(
          (await send("/api/auth/dev/switch-user", { userId: null })).status,
          404,
        );
      },
    );

    await t.test(
      "signed-out pages omit the signed-in account menu",
      async () => {
        for (const path of [
          "/volunteer/sign-in",
          "/volunteer/sign-in/complete",
        ]) {
          const page = await send(path);
          assert.equal(page.status, 200);
          assert.doesNotMatch(await page.text(), /data-account-menu/);
        }
      },
    );

    const cookie = await signIn("worker-volunteer@example.org");
    await t.test(
      "signed-in registration includes account navigation",
      async () => {
        const page = await send("/volunteer/register", undefined, cookie);
        assert.equal(page.status, 200);
        assert.match(await page.text(), /aria-label="Volunteer account"/);
      },
    );
    let current = (await (
      await send("/api/auth/get-session", undefined, cookie)
    ).json()) as { user: { id: string }; session: { id: string } };
    await t.test(
      "registration and edits round-trip through the real API",
      async () => {
        const response = await send("/api/account/profile", answers, cookie);
        assert.equal(response.status, 200, await response.clone().text());
        const page = await send("/volunteer/account", undefined, cookie);
        assert.equal(page.status, 200);
        const html = await page.text();
        assert.match(html, /Worker Test Volunteer/);
        assert.match(html, /aria-label="Volunteer account"/);
        assert.match(html, /Sample private answer/);
        assert.doesNotMatch(
          html,
          /Submitting saves your answers|Read the privacy notice/,
        );
        assert.doesNotMatch(
          html,
          /data-account-switcher|fonts.googleapis.com|cdn.shopify.com/,
        );
        assert.match(page.headers.get("cache-control")!, /no-store/);
        assert.equal(page.headers.get("referrer-policy"), "no-referrer");
        assert.match(
          page.headers.get("content-security-policy")!,
          /frame-ancestors 'none'/,
        );
        assert.equal(
          (
            await send(
              "/api/account/profile",
              { ...answers, userId: "another-user" },
              cookie,
            )
          ).status,
          400,
        );
        assert.equal(
          (
            await send(
              "/api/account/profile",
              answers,
              cookie,
              "https://evil.example",
            )
          ).status,
          403,
        );
        assert.equal(
          (await send("/api/auth/sign-out", {}, cookie, "https://evil.example"))
            .status,
          403,
        );
      },
    );

    await t.test(
      "session management lists only active owned sessions and revokes by ID without exposing tokens",
      async () => {
        const siblingCookie = await signIn("worker-volunteer@example.org");
        const expiredCookie = await signIn("worker-volunteer@example.org");
        const sibling = (await (
          await send("/api/auth/get-session", undefined, siblingCookie)
        ).json()) as { session: { id: string; token: string } };
        const expired = (await (
          await send("/api/auth/get-session", undefined, expiredCookie)
        ).json()) as { session: { id: string; token: string } };
        await DB.prepare("UPDATE session SET expires_at=? WHERE id=?")
          .bind(Date.now() - 1000, expired.session.id)
          .run();
        const page = await send("/volunteer/account", undefined, cookie);
        assert.equal(page.status, 200);
        const html = await page.text();
        assert.ok(html.includes(sibling.session.id));
        assert.ok(!html.includes(expired.session.id));
        assert.ok(!html.includes(sibling.session.token));
        assert.ok(!html.includes(expired.session.token));

        const revoked = await send(
          "/api/account/session",
          { id: sibling.session.id },
          cookie,
        );
        assert.equal(revoked.status, 200, await revoked.clone().text());
        assert.equal(
          await (
            await send("/api/auth/get-session", undefined, siblingCookie)
          ).json(),
          null,
        );
        assert.ok(
          await (await send("/api/auth/get-session", undefined, cookie)).json(),
        );
        assert.equal(
          (
            await send(
              "/api/account/session",
              { id: "unknown-session" },
              cookie,
            )
          ).status,
          200,
        );
        assert.equal(
          (await send("/api/account/session", { id: current.session.id }))
            .status,
          401,
        );
        assert.equal(
          (
            await send(
              "/api/account/session",
              { id: current.session.id },
              cookie,
              "https://evil.example",
            )
          ).status,
          403,
        );
      },
    );

    await t.test(
      "older sessions can edit their profile but must sign in again to list sessions",
      async () => {
        const original = await DB.prepare(
          "SELECT created_at AS createdAt FROM session WHERE id=?",
        )
          .bind(current.session.id)
          .first<{ createdAt: number }>();
        await DB.prepare("UPDATE session SET created_at=? WHERE id=?")
          .bind(Date.now() - 2 * 86_400_000, current.session.id)
          .run();
        try {
          const page = await send("/volunteer/account", undefined, cookie);
          assert.equal(page.status, 200, await page.clone().text());
          const html = await page.text();
          assert.match(html, /Sign in again to view and manage/);
          assert.match(html, /data-account-profile/);
          assert.doesNotMatch(html, /data-end-session|This device/);
        } finally {
          await DB.prepare("UPDATE session SET created_at=? WHERE id=?")
            .bind(original!.createdAt, current.session.id)
            .run();
        }
      },
    );

    await t.test(
      "ending another person's session cannot revoke it",
      async () => {
        const otherCookie = await signIn("other-worker-volunteer@example.org");
        const other = (await (
          await send("/api/auth/get-session", undefined, otherCookie)
        ).json()) as { session: { id: string } };
        assert.equal(
          (await send("/api/account/session", { id: other.session.id }, cookie))
            .status,
          200,
        );
        assert.equal(
          (await send("/api/auth/get-session", undefined, otherCookie)).status,
          200,
        );
        assert.ok(
          await (
            await send("/api/auth/get-session", undefined, otherCookie)
          ).json(),
        );
      },
    );

    await t.test(
      "GET link pages do not consume codes or set session cookies",
      async () => {
        const proof = await createSignInOTP(DB, secret, "scanner@example.org");
        const response = await send(
          `/volunteer/sign-in/complete#${new URLSearchParams(proof)}`,
        );
        assert.equal(response.status, 200);
        assert.equal(response.headers.get("set-cookie"), null);
        const row = await DB.prepare(
          "SELECT id FROM verification WHERE identifier = ?",
        )
          .bind(`sign-in-otp-${proof.email}`)
          .first();
        assert.ok(row?.id);
      },
    );

    await t.test(
      "unconfigured email delivery fails closed and removes its code",
      async () => {
        const page = await send("/volunteer/sign-in");
        assert.match(await page.text(), /Sign-in is not configured yet/);
        const response = await send(
          "/api/auth/email-otp/send-verification-otp",
          {
            email: "no-mail@example.org",
            type: "sign-in",
          },
        );
        assert.equal(response.status, 503);
        assert.match(
          ((await response.json()) as { message: string }).message,
          /Sign-in email is not configured yet/,
        );
        const count = await DB.prepare(
          "SELECT count(*) AS count FROM verification WHERE identifier = ?",
        )
          .bind("sign-in-otp-no-mail@example.org")
          .first();
        assert.equal(count?.count, 0);
      },
    );

    await t.test(
      "sign-in pages request no third-party scripts or frames",
      async () => {
        const browser = await chromium.launch({
          executablePath:
            process.env.CHROMIUM_PATH ??
            (existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : undefined),
        });
        try {
          const page = await browser.newPage();
          const external: string[] = [];
          const errors: string[] = [];
          page.on("request", (request) => {
            if (new URL(request.url()).origin !== origin)
              external.push(request.url());
          });
          page.on("pageerror", (error) => errors.push(error.message));
          await page.route("**/*", async (route) => {
            const request = route.request();
            if (!request.url().startsWith(origin)) return route.abort();
            const response = await worker.fetch(request.url(), {
              headers: await request.allHeaders(),
            });
            await route.fulfill({
              status: response.status,
              headers: Object.fromEntries(response.headers),
              body: Buffer.from(await response.arrayBuffer()),
            });
          });
          const response = await page.goto(`${origin}/volunteer/sign-in`);
          assert.match(
            response!.headers()["content-security-policy"],
            /frame-src 'none'/,
          );
          assert.equal(await page.locator("iframe").count(), 0);
          await assertAccountBackground(page);
          await page.setViewportSize({ width: 375, height: 812 });
          await assertAccountBackground(page);
          assert.deepEqual(
            await page
              .locator("[data-email-request] input")
              .evaluateAll((inputs) =>
                inputs.map((input) => input.getAttribute("name")),
              ),
            ["email"],
          );
          assert.deepEqual(external, []);
          assert.deepEqual(errors, []);
          await page.close();
        } finally {
          await browser.close();
        }
      },
    );

    await t.test(
      "browser edits persisted profile answers without browser storage or third-party requests",
      async () => {
        const browser = await chromium.launch({
          executablePath:
            process.env.CHROMIUM_PATH ??
            (existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : undefined),
        });
        try {
          const context = await browser.newContext();
          const browserCookie = cookie.split(";")[0];
          const split = browserCookie.indexOf("=");
          await context.addCookies([
            {
              name: browserCookie.slice(0, split),
              value: browserCookie.slice(split + 1),
              url: origin,
              httpOnly: true,
              secure: true,
            },
          ]);
          const page = await context.newPage();
          const external: string[] = [];
          const errors: string[] = [];
          page.on("console", (entry) => {
            if (entry.type() === "error") errors.push(entry.text());
          });
          page.on("request", (request) => {
            if (!request.url().startsWith(origin)) external.push(request.url());
          });
          page.on("pageerror", (error) => errors.push(error.message));
          // Every browser request goes to the local test Worker, never the live
          // production host. Keeping its real origin also exercises secure cookies.
          await page.route("**/*", async (route) => {
            const request = route.request();
            if (!request.url().startsWith(origin)) return route.abort();
            const response = await worker.fetch(request.url(), {
              method: request.method(),
              headers: await request.allHeaders(),
              body: request.postData() ?? undefined,
            });
            await route.fulfill({
              status: response.status,
              headers: Object.fromEntries(response.headers),
              body: Buffer.from(await response.arrayBuffer()),
            });
          });
          await page.goto(`${origin}/volunteer/account`);
          await page
            .getByRole("heading", { name: "Your account", exact: true })
            .waitFor();
          await assertAccountBackground(page);
          const nav = page.getByRole("navigation", {
            name: "Volunteer account",
          });
          const menu = nav.locator("[data-account-menu]");
          assert.equal(
            (
              await menu.locator("[data-account-menu-name]").textContent()
            )?.trim(),
            answers.name,
          );
          await menu.locator("summary").click();
          assert.equal(
            await menu
              .getByRole("link", { name: "Profile", exact: true })
              .getAttribute("href"),
            "/volunteer/account",
          );
          await menu.locator("summary").click();
          const changedName = "Worker Updated Volunteer";
          await page.getByLabel("Full or preferred name").fill(changedName);
          await page
            .getByLabel("Medical conditions or triggers", { exact: false })
            .fill("Changed browser sample");
          await page.getByRole("button", { name: "Save profile" }).click();
          try {
            await page
              .getByText("Profile saved.", { exact: true })
              .waitFor({ timeout: 5000 });
          } catch (error) {
            console.error(
              JSON.stringify({
                errors,
                messages: await page
                  .locator("[data-form-message]")
                  .allTextContents(),
                url: page.url(),
              }),
            );
            throw error;
          }
          assert.equal(
            (
              await menu.locator("[data-account-menu-name]").textContent()
            )?.trim(),
            changedName,
          );
          await page.reload();
          assert.equal(
            (
              await menu.locator("[data-account-menu-name]").textContent()
            )?.trim(),
            changedName,
          );
          assert.equal(
            await page
              .getByLabel("Medical conditions or triggers", { exact: false })
              .inputValue(),
            "Changed browser sample",
          );
          await page.screenshot({
            path: "/tmp/opencode/account-preview.png",
            fullPage: true,
          });
          assert.deepEqual(
            await page.evaluate(() => ({
              local: Object.keys(localStorage),
              session: Object.keys(sessionStorage),
            })),
            { local: [], session: [] },
          );
          assert.deepEqual(external, []);
          assert.deepEqual(errors, []);
          await context.close();

          const newContext = await browser.newContext();
          const newPage = await newContext.newPage();
          await newPage.route("**/*", async (route) => {
            const request = route.request();
            if (!request.url().startsWith(origin)) return route.abort();
            const response = await worker.fetch(request.url(), {
              method: request.method(),
              headers: await request.allHeaders(),
              body: request.postData() ?? undefined,
            });
            await route.fulfill({
              status: response.status,
              headers: Object.fromEntries(response.headers),
              body: Buffer.from(await response.arrayBuffer()),
            });
          });
          const proof = await createSignInOTP(
            DB,
            secret,
            "browser-new-volunteer@example.org",
          );
          await newPage.goto(
            `${origin}/volunteer/sign-in/complete#${new URLSearchParams(proof)}`,
          );
          await newPage
            .getByRole("button", { name: "Confirm sign-in" })
            .waitFor();
          assert.equal(new URL(newPage.url()).hash, "");
          assert.ok(
            await DB.prepare("SELECT id FROM verification WHERE identifier=?")
              .bind(`sign-in-otp-${proof.email}`)
              .first(),
          );
          await newPage
            .getByRole("button", { name: "Confirm sign-in" })
            .click();
          await newPage
            .getByRole("heading", {
              name: "Volunteer registration",
              exact: true,
            })
            .waitFor();
          await assertAccountBackground(newPage);
          for (const [name, value] of Object.entries(answers)) {
            if (name === "teams") continue;
            await newPage.locator(`[name="${name}"]`).fill(String(value));
          }
          await newPage.locator('[name="teams"][value="outreach"]').check();
          await newPage
            .getByRole("button", { name: "Complete registration" })
            .click();
          await newPage
            .getByRole("heading", { name: "Your account", exact: true })
            .waitFor();
          assert.equal(
            await newPage.locator('[name="name"]').inputValue(),
            answers.name,
          );
          assert.equal(
            (
              await newPage.locator("[data-account-menu-name]").textContent()
            )?.trim(),
            answers.name,
          );
          assert.equal(newPage.url(), `${origin}/volunteer/account`);
          const consumed = await DB.prepare(
            "SELECT id FROM verification WHERE identifier = ?",
          )
            .bind(`sign-in-otp-${proof.email}`)
            .first();
          assert.equal(consumed, null);
          await newPage.locator("[data-account-menu] > summary").click();
          await newPage
            .getByRole("button", { name: "Sign out", exact: true })
            .click();
          await newPage
            .getByRole("heading", { name: "Sign in", exact: true })
            .waitFor();
          await newPage.goto(`${origin}/volunteer/account`);
          await newPage
            .getByRole("heading", { name: "Sign in", exact: true })
            .waitFor();
          await newContext.close();
        } finally {
          await browser.close();
        }
      },
    );

    await t.test("sign-out removes the server-side session", async () => {
      current = (await (
        await send("/api/auth/get-session", undefined, cookie)
      ).json()) as typeof current;
      assert.equal((await send("/api/auth/sign-out", {}, cookie)).status, 200);
      const result = await DB.prepare("SELECT id FROM session WHERE id = ?")
        .bind(current.session.id)
        .first();
      assert.equal(result, null);
      assert.equal(
        await (await send("/api/auth/get-session", undefined, cookie)).json(),
        null,
      );
      const signedOut = await send("/volunteer/sign-in", undefined, cookie);
      assert.doesNotMatch(await signedOut.text(), /data-account-menu/);
    });
    await t.test(
      "the Worker encrypts authenticator data and requires a second factor after email sign-in",
      async () => {
        const email = "worker-factor@example.org";
        const initialCookie = await signIn(email);
        await send("/api/account/profile", answers, initialCookie);
        const enabled = await send(
          "/api/auth/two-factor/enable",
          { method: "totp" },
          initialCookie,
        );
        assert.equal(enabled.status, 200, await enabled.clone().text());
        const setup = (await enabled.json()) as {
          totpURI: string;
          backupCodes: string[];
        };
        const key = new URL(setup.totpURI).searchParams.get("secret")!;
        const confirmed = await send(
          "/api/auth/two-factor/verify-totp",
          { code: totpFromSetupKey(key) },
          initialCookie,
        );
        assert.equal(confirmed.status, 200, await confirmed.clone().text());
        const confirmedCookie = confirmed.headers
          .getSetCookie()
          .filter((value) => !value.includes("Max-Age=0"))
          .map((value) => value.split(";")[0])
          .join("; ");
        const factorSession = (await (
          await send("/api/auth/get-session", undefined, confirmedCookie)
        ).json()) as { session: { twoFactorVerified: boolean } };
        assert.equal(factorSession.session.twoFactorVerified, true);
        const encrypted = await DB.prepare(
          "SELECT secret, backup_codes FROM two_factor",
        ).all();
        assert.doesNotMatch(JSON.stringify(encrypted), new RegExp(key));
        assert.doesNotMatch(
          JSON.stringify(encrypted),
          new RegExp(setup.backupCodes[0]),
        );
        await send("/api/auth/sign-out", {}, confirmedCookie);

        const proof = await createSignInOTP(DB, secret, email);
        const pending = await send(
          "/api/auth/sign-in/email-otp?returnTo=%2Fvolunteer%2Faccount%3Ftab%3Dfactor",
          proof,
        );
        assert.equal(pending.status, 200);
        assert.equal(
          ((await pending.clone().json()) as { twoFactorRedirect: boolean })
            .twoFactorRedirect,
          true,
        );
        const pendingCookie = pending.headers
          .getSetCookie()
          .filter((value) => !value.includes("Max-Age=0"))
          .map((value) => value.split(";")[0])
          .join("; ");
        assert.equal(
          await (
            await send("/api/auth/get-session", undefined, pendingCookie)
          ).json(),
          null,
        );
        assert.equal(
          (await send("/api/account/profile", answers, pendingCookie)).status,
          401,
        );
        const verified = await send(
          "/api/auth/two-factor/verify-backup-code",
          { code: setup.backupCodes[0] },
          pendingCookie,
        );
        assert.equal(verified.status, 200, await verified.clone().text());
        assert.equal(
          ((await verified.clone().json()) as { next: string }).next,
          "/volunteer/account?tab=factor",
        );
        const verifiedCookie = verified.headers
          .getSetCookie()
          .filter((value) => !value.includes("Max-Age=0"))
          .map((value) => value.split(";")[0])
          .join("; ");
        const result = (await (
          await send("/api/auth/get-session", undefined, verifiedCookie)
        ).json()) as { session: { twoFactorVerified: boolean } };
        assert.equal(result.session.twoFactorVerified, true);
      },
    );
    assert.doesNotMatch(
      JSON.stringify(server.getLogs()),
      /Sample private answer|Changed browser sample|worker-volunteer@example.org/,
    );
  } catch (error) {
    // This runtime is isolated and contains only the test fixture above.
    console.error(JSON.stringify(server.getLogs()));
    throw error;
  } finally {
    await server.close();
  }
});
