import { existsSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { chromium, expect as browserExpect } from "@playwright/test";
import { createTestHarness } from "wrangler";
import { createSignInOTP } from "../helpers/email-otp";
import { sampleAnswers } from "../helpers/local-account";
import { profileWriteBody } from "../helpers/profile-write";

const origin = "https://afterhoursoutreach.ca";
const secret = "launch-readiness-test-secret-12345678901234567890";

describe("launch readiness regressions", { concurrent: false }, () => {
  const server = createTestHarness({
    workers: [
      {
        configPath: "dist/server/wrangler.json",
        vars: { APP_ENV: "production", AUTH_BASE_URL: origin },
        secrets: {
          BETTER_AUTH_SECRET: secret,
          RESEND_API_KEY: "test-only-key",
        },
      },
    ],
  });
  let worker: ReturnType<typeof server.getWorker<Env>>;
  let DB: Env["DB"];
  let owner: { id: string; cookie: string };
  let other: typeof owner;
  const send = async (
    path: string,
    cookie: string,
    body?: object,
  ): ReturnType<typeof worker.fetch> => {
    if (path === "/api/v1/account/profile" && body)
      body = await profileWriteBody((path) => send(path, cookie), body);
    return worker.fetch(`${origin}${path}`, {
      method: body ? "POST" : "GET",
      headers: { origin, cookie, "content-type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
      redirect: "manual",
    });
  };
  const person = async (email: string) => {
    const response = await send(
      "/api/v1/auth/sign-in/email-otp",
      "",
      await createSignInOTP(DB, secret, email),
    );
    expect(response.status).toBe(200);
    const { user } = (await response.json()) as { user: { id: string } };
    const cookie = response.headers
      .getSetCookie()
      .filter((value) => !value.includes("Max-Age=0"))
      .map((value) => value.split(";")[0])
      .join("; ");
    const saved = await send("/api/v1/account/profile", cookie, {
      ...sampleAnswers,
      codeOfConductAccepted: true,
    });
    expect(saved.status).toBe(200);
    return { id: user.id, cookie };
  };
  beforeAll(async () => {
    await server.listen();
    worker = server.getWorker<Env>();
    await worker.applyD1Migrations("DB");
    DB = (await worker.getEnv()).DB;
    owner = await person("launch-owner@example.org");
    other = await person("launch-other@example.org");
  });
  afterAll(() => server.close());

  const browserWithSession = async (initialCookie: string) => {
    const browser = await chromium.launch({
      executablePath:
        process.env.CHROMIUM_PATH ??
        (existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : undefined),
    });
    const page = await browser.newPage();
    let cookie = initialCookie;
    await page.route("**/*", async (route) => {
      const request = route.request();
      if (new URL(request.url()).origin !== origin) return route.abort();
      const response = await worker.fetch(request.url(), {
        method: request.method(),
        headers: { ...(await request.allHeaders()), cookie },
        body: request.postData() ?? undefined,
        redirect: "manual",
      });
      await route.fulfill({
        status: response.status,
        headers: Object.fromEntries(response.headers),
        body: Buffer.from(await response.arrayBuffer()),
      });
    });
    return {
      browser,
      page,
      useCookie: (value: string) => {
        cookie = value;
      },
    };
  };

  test("sessions predating authenticator enrollment cannot read or edit private account data", async () => {
    // Enrollment on another device leaves this pre-existing session unverified.
    await DB.prepare("UPDATE user SET two_factor_enabled=1 WHERE id=?")
      .bind(owner.id)
      .run();
    try {
      const page = await send("/volunteer/account", owner.cookie);
      expect(page.status).toBe(302);
      expect(page.headers.get("location")).toContain("/volunteer/sign-in");
      expect(
        (await send("/api/v1/account/profile", owner.cookie, sampleAnswers))
          .status,
      ).toBe(403);
      expect(
        (
          await send("/api/v1/account/session", owner.cookie, {
            id: "another-session",
          })
        ).status,
      ).toBe(403);
      // Reauthentication must not redirect the unverified session back into a loop.
      expect((await send("/volunteer/sign-in", owner.cookie)).status).toBe(200);
    } finally {
      await DB.prepare("UPDATE user SET two_factor_enabled=0 WHERE id=?")
        .bind(owner.id)
        .run();
    }
  });

  test("an old profile tab cannot overwrite a different signed-in account", async () => {
    const { browser, page, useCookie } = await browserWithSession(owner.cookie);
    try {
      await page.goto(`${origin}/volunteer/account`);
      const section = page.locator("[data-profile-section]").filter({
        has: page.locator("#account-profile-personal-info"),
      });
      await section.getByRole("button", { name: "Edit" }).click();
      await section
        .locator('[name="preferredName"]')
        .fill("Stale tab overwrite");
      useCookie(other.cookie);
      const saved = page.waitForResponse((response) =>
        response.url().endsWith("/account/profile"),
      );
      await section.getByRole("button", { name: "Save", exact: true }).click();
      expect((await saved).status()).toBe(403);
      await browserExpect(page.getByRole("alert")).toContainText(
        "Your account changed",
      );
      expect(
        await DB.prepare("SELECT preferred_name FROM profile WHERE user_id=?")
          .bind(other.id)
          .first("preferred_name"),
      ).toBe(sampleAnswers.preferredName);
    } finally {
      await browser.close();
    }
  });

  test("live polling redirects to a usable sign-in page after session expiry", async () => {
    const { browser, page, useCookie } = await browserWithSession(owner.cookie);
    try {
      let contentType = "";
      await page.clock.install();
      await page.route(
        "**/api/v1/auth/email-otp/send-verification-otp**",
        async (route) => {
          contentType = route.request().headers()["content-type"];
          await route.fulfill({ json: { success: true } });
        },
      );
      await page.goto(`${origin}/volunteer`);
      await browserExpect(
        page.locator(
          '[data-application-awaiting-approval="true"] [data-application-tracker]',
        ),
      ).toBeVisible();
      useCookie("");
      await page.clock.runFor(60_000);
      const request = page.locator("[data-email-request]");
      await browserExpect(request).toBeVisible({ timeout: 10_000 });
      await request
        .getByRole("textbox", { name: "Email", exact: true })
        .fill("reauth@example.org");
      await request
        .getByRole("button", { name: "Continue with Email" })
        .click();
      await browserExpect.poll(() => contentType).toContain("application/json");
      await browserExpect(page.locator("[data-email-code]")).toBeVisible();
      await browserExpect(page).toHaveURL(
        `${origin}/volunteer/sign-in?returnTo=%2Fvolunteer`,
      );
    } finally {
      await browser.close();
    }
  });

  test("the built Worker renders concurrent authenticated requests without empty pages", async () => {
    await DB.batch([
      DB.prepare(
        "UPDATE profile SET naloxone_completed_at=? WHERE user_id=?",
      ).bind(Date.now(), owner.id),
      DB.prepare(
        "UPDATE volunteer_status SET registration_approved=1 WHERE user_id=?",
      ).bind(owner.id),
    ]);
    const paths = [
      "/",
      "/about",
      "/donate",
      "/privacy",
      "/events",
      "/volunteer/account",
      "/apply",
      "/api/v1/events/version",
    ];
    await Promise.all(
      Array.from({ length: 24 }, async (_, index) => {
        const path = paths[index % paths.length];
        const response = await send(path, owner.cookie);
        expect(response.status, path).toBe(path === "/apply" ? 302 : 200);
        if (response.status === 200)
          expect(await response.text(), path).not.toBe("");
        else await response.body?.cancel();
      }),
    );
  });

  test("public information stays available when account navigation cannot reach its tables", async () => {
    await DB.prepare("DROP TABLE volunteer_status").run();
    for (const path of ["/", "/about", "/donate", "/privacy"]) {
      const page = await send(path, owner.cookie);
      expect(page.status, path).toBe(200);
      expect(page.headers.get("cache-control")).toBe("no-store");
      expect(await page.text()).not.toContain("data-account-menu=");
    }
    // Account failures must not be disguised as a healthy database.
    expect((await send("/api/v1/health", "")).status).toBe(503);
  });
});
