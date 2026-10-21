import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { test } from "vitest";
import { chromium, expect } from "@playwright/test";
import { createTestHarness } from "wrangler";
import { createSignInOTP } from "../helpers/email-otp";
import { formatApplicationSubmittedTime } from "../../src/data/application";

test("organizers review submitted applications with a global queue count and persistent list context", async () => {
  const origin = "https://afterhoursoutreach.ca";
  const secret = "application-queue-test-secret-12345678901234567890";
  const server = createTestHarness({
    workers: [
      {
        configPath: "dist/server/wrangler.json",
        vars: { APP_ENV: "production", AUTH_BASE_URL: origin },
        secrets: { BETTER_AUTH_SECRET: secret, RESEND_API_KEY: "" },
      },
    ],
  });
  const browser = await chromium.launch({
    executablePath:
      process.env.CHROMIUM_PATH ??
      (existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : undefined),
  });
  let releaseSearch = () => {};
  try {
    await server.listen();
    const worker = server.getWorker<Env>();
    await worker.applyD1Migrations("DB");
    const { DB } = await worker.getEnv();
    const pendingIds = Array.from(
      { length: 53 },
      (_, index) => `applicant-${String(index).padStart(2, "0")}`,
    );
    for (const id of [
      "organizer",
      "approved",
      ...pendingIds,
      "draft-only",
      "account-only",
    ]) {
      await DB.prepare(
        "INSERT INTO user (id, name, email, email_verified, role, created_at, updated_at) VALUES (?, ?, ?, 1, ?, 0, 0)",
      )
        .bind(
          id,
          id,
          `${id}@example.org`,
          id === "organizer" ? "organizer" : "volunteer",
        )
        .run();
      if (["draft-only", "account-only"].includes(id)) continue;
      await DB.batch([
        DB.prepare(
          `INSERT INTO profile (
          user_id, preferred_name, phone, birth_date, emergency_contact_name,
          emergency_contact_phone, emergency_contact_relationship, heard_about_us,
          motivation, teams, medical_certification, training_experience, medical_conditions, registered_at, updated_at
        ) VALUES (?, ?, '555', '2000-01-01', 'Contact', '555', 'Friend', 'Friend', 'Help', '[]', 'None', 'None', 'PRIVATE QUEUE ANSWER', 0, 0)`,
        ).bind(id, id),
        DB.prepare(
          "INSERT INTO volunteer_status (user_id, registration_approved, updated_at) VALUES (?, ?, 0)",
        ).bind(id, pendingIds.includes(id) ? 0 : 1),
      ]);
    }
    const submittedAt = "2026-09-15T18:30:00.000Z";
    await DB.prepare(
      "UPDATE profile SET registered_at=?, code_of_conduct_version='2026-09-01', code_of_conduct_accepted_at=? WHERE user_id='applicant-50'",
    )
      .bind(Date.parse(submittedAt), Date.parse(submittedAt))
      .run();
    await DB.prepare(
      "INSERT INTO application_draft (user_id, version, revision, answers, updated_at) VALUES ('draft-only', 1, 'draft-revision', ?, 0)",
    )
      .bind(JSON.stringify({ firstName: "SECRET DRAFT NAME" }))
      .run();
    const signIn = async (id: string) => {
      const proof = await createSignInOTP(DB, secret, `${id}@example.org`);
      const response = await worker.fetch(
        `${origin}/api/v1/auth/sign-in/email-otp`,
        {
          method: "POST",
          headers: { origin, "content-type": "application/json" },
          body: JSON.stringify(proof),
        },
      );
      assert.equal(response.status, 200, await response.clone().text());
      return response.headers
        .getSetCookie()
        .filter((value) => !value.includes("Max-Age=0"))
        .map((value) => value.split(";")[0])
        .join("; ");
    };
    const cookie = await signIn("organizer");
    const volunteerCookie = await signIn("approved");
    const get = (path: string, auth = cookie) =>
      worker.fetch(`${origin}${path}`, {
        redirect: "manual",
        headers: { cookie: auth },
      });
    const listPath = "/volunteers?approval=awaiting&q=applicant&offset=50";
    const anonymous = await get(listPath, "");
    assert.equal(anonymous.status, 302);
    assert.equal(
      new URL(anonymous.headers.get("location")!, origin).searchParams.get(
        "returnTo",
      ),
      "/volunteers?q=applicant&approval=awaiting&offset=50",
    );
    for (const path of [listPath, "/volunteers/applicant-50"])
      assert.equal((await get(path, volunteerCookie)).status, 403);
    for (const [oldPath, destination] of [
      [
        "/volunteer?type=orientation&occurrence=a%2Fb",
        "/events?type=orientation&occurrence=a%2Fb",
      ],
      [
        "/volunteer/volunteers?approval=awaiting&q=applicant&offset=50",
        listPath,
      ],
      [
        "/volunteer/volunteers/applicant-50?returnTo=%2Fvolunteer%2Fvolunteers%3Fapproval%3Dawaiting",
        "/volunteers/applicant-50?returnTo=%2Fvolunteer%2Fvolunteers%3Fapproval%3Dawaiting",
      ],
    ]) {
      const legacy = await get(oldPath);
      assert.equal(
        legacy.status,
        oldPath.startsWith("/volunteer?") ? 302 : 301,
      );
      assert.equal(legacy.headers.get("location"), destination);
      assert.equal(legacy.headers.get("cache-control"), "no-store");
    }
    const eventPath = "/events?type=orientation&occurrence=a%2Fb";
    const introduction = await get("/volunteer?type=orientation", "");
    assert.equal(introduction.status, 200);
    assert.match(
      await introduction.text(),
      /data-return-to="\/events\?type=orientation"/,
    );
    const signedOutEvents = await get(eventPath, "");
    assert.equal(signedOutEvents.status, 302);
    assert.equal(
      new URL(
        signedOutEvents.headers.get("location")!,
        origin,
      ).searchParams.get("returnTo"),
      eventPath,
    );
    for (const auth of [cookie, volunteerCookie]) {
      const events = await get("/events", auth);
      assert.equal(events.status, 200);
      assert.equal(events.headers.get("cache-control"), "no-store");
      assert.equal(
        events.headers.get("x-robots-tag"),
        "noindex, nofollow, noarchive",
      );
      assert.equal(events.headers.get("referrer-policy"), "no-referrer");
      assert.match(
        events.headers.get("content-security-policy")!,
        /frame-src 'none'/,
      );
      const eventHtml = await events.text();
      assert.match(eventHtml, /<title>Events \|/);
      assert.match(eventHtml, /href="\/events"/);
      assert.doesNotMatch(eventHtml, /href="\/volunteer"/);
      assert.equal(eventHtml.includes('href="/volunteers"'), auth === cookie);
    }
    const response = await get(listPath);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const html = await response.text();
    assert.match(html, /data-awaiting-approval-count>53</);
    assert.doesNotMatch(
      html,
      /PRIVATE QUEUE ANSWER|SECRET DRAFT NAME|draft-only|account-only/,
    );
    const auditCount = () =>
      DB.prepare(
        "SELECT count(*) AS n FROM audit_log WHERE action='profile_viewed'",
      ).first<number>("n");
    assert.equal(await auditCount(), 0);

    const context = await browser.newContext();
    await context.addCookies(
      cookie.split("; ").map((value) => {
        const index = value.indexOf("=");
        return {
          name: value.slice(0, index),
          value: value.slice(index + 1),
          url: origin,
        };
      }),
    );
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("**/*", async (route) => {
      const request = route.request();
      if (!request.url().startsWith(origin)) return route.abort();
      const result = await worker.fetch(request.url(), {
        method: request.method(),
        headers: await request.allHeaders(),
        body: request.postDataBuffer() ?? undefined,
        redirect: "manual",
      });
      await route.fulfill({
        status: result.status,
        headers: Object.fromEntries(result.headers),
        body: Buffer.from(await result.arrayBuffer()),
      });
    });
    await page.goto(`${origin}${listPath}`);
    const count = page.locator("[data-awaiting-approval-count]");
    const results = page.locator("[data-volunteer-results]");
    await expect(count).toHaveText("53");
    await expect(results.locator("li")).toHaveCount(3);
    const filters = page.getByRole("group", { name: "Application approval" });
    const allApplicants = filters.getByRole("button", {
      name: "All applicants",
    });
    const awaitingApproval = filters.getByRole("button", {
      name: "Awaiting approval (53)",
    });
    await expect(awaitingApproval).toHaveAttribute("aria-pressed", "true");
    await expect(
      page.getByRole("link", { name: "Previous volunteers" }),
    ).toHaveAttribute("href", /q=applicant&approval=awaiting/);
    const documents: string[] = [];
    page.on("request", (request) => {
      if (request.resourceType() === "document") documents.push(request.url());
    });
    await allApplicants.click();
    await expect(allApplicants).toHaveAttribute("aria-pressed", "true");
    await expect(allApplicants).toBeFocused();
    await expect(results.locator("li")).toHaveCount(50);
    await expect(page).toHaveURL(`${origin}/volunteers?q=applicant`);
    await awaitingApproval.click();
    await expect(awaitingApproval).toHaveAttribute("aria-pressed", "true");
    await expect(page).toHaveURL(
      `${origin}/volunteers?q=applicant&approval=awaiting`,
    );
    await page.goBack();
    await expect(allApplicants).toHaveAttribute("aria-pressed", "true");
    await page.goBack();
    await expect(awaitingApproval).toHaveAttribute("aria-pressed", "true");
    await expect(results.locator("li")).toHaveCount(3);
    assert.equal(page.url(), `${origin}${listPath}`);
    assert.deepEqual(documents, []);
    const reviewLink = results.locator("[data-volunteer-profile-link]").first();
    const profileHref = await reviewLink.getAttribute("href");
    assert.ok(profileHref);
    await reviewLink.click();
    const dialog = page.locator("[data-volunteer-profile-dialog]");
    await expect(
      dialog.getByText("PRIVATE QUEUE ANSWER", { exact: true }),
    ).toBeVisible();
    await expect(
      dialog.getByText("Application awaiting approval", { exact: true }),
    ).toBeVisible();
    const summary = dialog.locator(".account-profile-summary");
    await expect(summary.getByRole("heading")).toHaveText([
      "Submission details",
      "Personal info",
      "Emergency contact",
      "Team interests",
      "Training and safety",
      "About volunteering",
    ]);
    const answer = (label: string) =>
      summary
        .locator("dl > div")
        .filter({ has: page.getByText(label, { exact: true }) })
        .locator("dd");
    await expect(answer("Email")).toHaveText("applicant-50@example.org");
    await expect(answer("Submitted")).toHaveText(
      formatApplicationSubmittedTime(submittedAt),
    );
    await expect(answer("Code of Conduct version accepted")).toHaveText(
      "2026-09-01",
    );
    await expect(answer("Code of Conduct accepted")).toHaveText(
      formatApplicationSubmittedTime(submittedAt),
    );
    assert.equal(await auditCount(), 1);
    // Merely reading the application is not review completion.
    await dialog
      .getByRole("button", { name: "Close volunteer profile" })
      .click();
    await expect(count).toHaveText("53");
    await expect(results.locator("li")).toHaveCount(3);
    assert.equal(page.url(), `${origin}${listPath}`);
    const heldSearch = new Promise<void>((resolve) => {
      releaseSearch = resolve;
    });
    let searchStarted!: () => void;
    const startedSearch = new Promise<void>((resolve) => {
      searchStarted = resolve;
    });
    let held = false;
    await page.route("**/volunteers?*", async (route) => {
      const request = route.request();
      if (
        held ||
        request.isNavigationRequest() ||
        new URL(request.url()).searchParams.has("offset")
      )
        return route.fallback();
      held = true;
      // This response observes the pre-approval state and must never restore it.
      const stale = await worker.fetch(request.url(), {
        headers: await request.allHeaders(),
      });
      const body = Buffer.from(await stale.arrayBuffer());
      searchStarted();
      await heldSearch;
      await route.fulfill({
        status: stale.status,
        headers: Object.fromEntries(stale.headers),
        body,
      });
    });
    await page.locator("[data-volunteer-search]").fill("applicant");
    await startedSearch;
    await reviewLink.click();
    await dialog
      .getByRole("button", { name: "Approve application", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Save without email", exact: true })
      .click();
    await expect(
      dialog.getByRole("button", { name: "Revoke application approval" }),
    ).toBeEnabled();
    await expect(count).toHaveText("52");
    await expect(results.locator("li")).toHaveCount(2);
    releaseSearch();
    await expect(dialog).toBeVisible();
    await dialog
      .getByRole("button", { name: "Close volunteer profile" })
      .click();
    assert.equal(page.url(), `${origin}${listPath}`);
    // Normal full-page links retain exactly the same list context.
    await page.goto(`${origin}${profileHref}`);
    await expect(
      page.getByRole("link", { name: "Back to volunteers" }),
    ).toHaveAttribute(
      "href",
      "/volunteers?q=applicant&approval=awaiting&offset=50",
    );
    await page
      .getByRole("button", { name: "Revoke application approval" })
      .click();
    await page
      .getByRole("button", { name: "Save without email", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Approve application", exact: true }),
    ).toBeEnabled();
    await page.getByRole("link", { name: "Back to volunteers" }).click();
    await page.waitForLoadState("load");
    await expect(count).toHaveText("53");
    await expect(results.locator("li")).toHaveCount(3);
    const search = page.locator("[data-volunteer-search]");
    await search.fill("applicant-52");
    await expect(results.locator("li")).toHaveCount(1);
    await expect(count).toHaveText("53");
    expect(new URL(page.url()).searchParams.get("approval")).toBe("awaiting");
    expect(new URL(page.url()).searchParams.has("offset")).toBe(false);
    await search.fill("approved");
    await expect(results.locator("li")).toHaveCount(0);
    await allApplicants.click();
    await expect(results.locator("li")).toHaveCount(1);
    await expect(
      results.getByRole("heading", { name: "approved", exact: true }),
    ).toBeVisible();
    await expect(page).toHaveURL(`${origin}/volunteers?q=approved`);
    await page.goBack();
    await expect(awaitingApproval).toHaveAttribute("aria-pressed", "true");
    await expect(results.locator("li")).toHaveCount(0);
    await expect(search).toHaveValue("approved");
    await search.fill("no match");
    await expect(
      results.getByText("No applications awaiting approval match your search."),
    ).toBeVisible();
    await expect(count).toHaveText("53");
    await search.fill("applicant");
    await expect(results.locator("li")).toHaveCount(50);
    await page.getByRole("link", { name: "Next volunteers" }).click();
    await expect(results.locator("li")).toHaveCount(3);
    expect(new URL(page.url()).searchParams.get("approval")).toBe("awaiting");
    expect(new URL(page.url()).searchParams.get("q")).toBe("applicant");
    assert.deepEqual(errors, []);
    // The plain GET form is functional without the search script too.
    const noJs = await browser.newContext({
      javaScriptEnabled: false,
      storageState: await context.storageState(),
    });
    const plain = await noJs.newPage();
    await plain.route("**/*", async (route) => {
      const request = route.request();
      if (!request.url().startsWith(origin)) return route.abort();
      const result = await worker.fetch(request.url(), {
        headers: await request.allHeaders(),
        redirect: "manual",
      });
      await route.fulfill({
        status: result.status,
        headers: Object.fromEntries(result.headers),
        body: Buffer.from(await result.arrayBuffer()),
      });
    });
    await plain.goto(`${origin}${listPath}`);
    await plain.locator("[data-volunteer-search]").fill("applicant-52");
    await plain.getByRole("button", { name: "Search", exact: true }).click();
    await expect(plain.locator("[data-volunteer-results] li")).toHaveCount(1);
    expect(new URL(plain.url()).searchParams.get("approval")).toBe("awaiting");
    expect(new URL(plain.url()).searchParams.has("offset")).toBe(false);
    await plain.getByRole("button", { name: "All applicants" }).click();
    expect(new URL(plain.url()).searchParams.get("q")).toBe("applicant-52");
    await expect(
      plain.getByRole("button", { name: "All applicants" }),
    ).toHaveAttribute("aria-pressed", "true");
    await plain.getByRole("button", { name: "Awaiting approval (53)" }).click();
    await plain.locator("[data-volunteer-profile-link]").click();
    await expect(
      plain.getByRole("link", { name: "Back to volunteers" }),
    ).toHaveAttribute("href", "/volunteers?q=applicant-52&approval=awaiting");
    // Returning through bfcache must refresh approval changes without losing the
    // restored search or page, even when the last page becomes empty.
    await page.waitForLoadState("load");
    const restoredListUrl = page.url();
    await DB.prepare(
      "UPDATE volunteer_status SET registration_approved=1 WHERE user_id IN ('applicant-50', 'applicant-51', 'applicant-52')",
    ).run();
    await page.evaluate(() =>
      window.dispatchEvent(
        new PageTransitionEvent("pageshow", { persisted: true }),
      ),
    );
    await expect(count).toHaveText("50");
    await expect(results.locator("li")).toHaveCount(0);
    await expect(
      results.getByText(
        "No applications awaiting approval on this page. Return to the previous page.",
      ),
    ).toBeVisible();
    expect(page.url()).toBe(restoredListUrl);
    await page.getByRole("link", { name: "Previous volunteers" }).click();
    await expect(results.locator("li")).toHaveCount(50);
    expect(new URL(page.url()).searchParams.get("approval")).toBe("awaiting");
    await DB.prepare(
      "UPDATE volunteer_status SET registration_approved=1",
    ).run();
    await page.goto(`${origin}/volunteers?approval=awaiting`);
    await expect(count).toHaveText("0");
    await expect(
      results.getByText("No applications are awaiting approval."),
    ).toBeVisible();
  } finally {
    releaseSearch();
    await browser.close();
    await server.close();
  }
});
