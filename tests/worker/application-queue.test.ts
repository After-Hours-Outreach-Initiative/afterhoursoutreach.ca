import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { test } from "vitest";
import { chromium, expect } from "@playwright/test";
import { createTestHarness } from "wrangler";
import { createSignInOTP } from "../helpers/email-otp";
import {
  formatApplicationCompletedTime,
  formatApplicationSubmittedTime,
} from "../../src/data/application";

test("organizers review applications separately from approved volunteers with persistent list context", async () => {
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
          "INSERT INTO volunteer_status (user_id, registration_approved, patrol_approved, approved_by, approved_at, updated_at) VALUES (?, ?, ?, ?, ?, 0)",
        ).bind(
          id,
          pendingIds.includes(id) ? 0 : 1,
          Number(id === "organizer"),
          id === "organizer" ? id : null,
          id === "organizer" ? 0 : null,
        ),
      ]);
    }
    // Ready applicants have completed their steps before organizer review.
    await DB.prepare("DELETE FROM discord_requirement").run();
    await DB.prepare("UPDATE profile SET naloxone_completed_at=0").run();
    const submittedAt = "2026-09-15T18:30:00.000Z";
    const completedAt = "2026-09-16T19:45:00.000Z";
    // Status sorting puts newest completions first. Keep the detailed subject
    // on the second page rather than moving it ahead of the first 50 fixtures.
    await DB.prepare(
      "UPDATE profile SET naloxone_completed_at=? WHERE user_id >= 'applicant-00' AND user_id < 'applicant-50'",
    )
      .bind(Date.parse(completedAt) + 1)
      .run();
    await DB.prepare(
      "UPDATE profile SET first_name='Alex', middle_names='Jordan Marie', last_name='de la Cruz', registered_at=?, naloxone_completed_at=?, code_of_conduct_version='2026-09-01', code_of_conduct_accepted_at=? WHERE user_id='applicant-50'",
    )
      .bind(
        Date.parse(submittedAt),
        Date.parse(completedAt),
        Date.parse(submittedAt),
      )
      .run();
    await DB.prepare(
      "UPDATE profile SET teams='[\"medic\"]' WHERE user_id='applicant-51'",
    ).run();
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
    const listPath = "/applications?approval=awaiting&q=applicant&offset=50";
    const anonymous = await get(listPath, "");
    assert.equal(anonymous.status, 302);
    assert.equal(
      new URL(anonymous.headers.get("location")!, origin).searchParams.get(
        "returnTo",
      ),
      "/applications?q=applicant&approval=awaiting&offset=50",
    );
    for (const path of [listPath, "/volunteers", "/volunteers/applicant-50"])
      assert.equal((await get(path, volunteerCookie)).status, 403);
    for (const [oldPath, destination] of [
      [
        "/volunteer/volunteers?approval=awaiting&q=applicant&offset=50",
        "/volunteers?approval=awaiting&q=applicant&offset=50",
      ],
      [
        "/volunteer/volunteers/applicant-50?returnTo=%2Fvolunteer%2Fvolunteers%3Fapproval%3Dawaiting",
        "/volunteers/applicant-50?returnTo=%2Fvolunteer%2Fvolunteers%3Fapproval%3Dawaiting",
      ],
      [
        "/manage/volunteers?approval=awaiting&q=applicant&offset=50",
        "/volunteers?approval=awaiting&q=applicant&offset=50",
      ],
      ["/manage/volunteers/applicant-50", "/volunteers/applicant-50"],
      [
        "/manage/applications?approval=awaiting&q=applicant&offset=50",
        listPath,
      ],
      [
        "/manage/events?type=orientation&occurrence=a%2Fb",
        "/events?type=orientation&occurrence=a%2Fb&view=organizer",
      ],
    ]) {
      const legacy = await get(oldPath);
      assert.equal(legacy.status, 301);
      assert.equal(legacy.headers.get("location"), destination);
      assert.equal(legacy.headers.get("cache-control"), "no-store");
    }
    const eventPath = "/events?type=orientation&occurrence=a%2Fb";
    const introduction = await get("/volunteer?type=orientation", "");
    assert.equal(introduction.status, 200);
    assert.match(await introduction.text(), /data-return-to="\/volunteer"/);
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
      const signIn = await get(
        "/volunteer/sign-in?returnTo=%2Fmanage%2Fevents",
        auth,
      );
      assert.equal(signIn.status, 302);
      assert.equal(signIn.headers.get("location"), "/volunteer");
      const landing = await get(
        "/volunteer?type=orientation&occurrence=a%2Fb",
        auth,
      );
      assert.equal(landing.status, 200);
      const landingHtml = await landing.text();
      assert.match(landingHtml, /data-event-path="\/volunteer"/);
      assert.match(landingHtml, /data-event-access="true"/);
      assert.doesNotMatch(landingHtml, /data-event-view-link/);
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
      assert.equal(eventHtml.includes('href="/applications"'), auth === cookie);
      assert.doesNotMatch(eventHtml, /data-event-view-link/);
      assert.doesNotMatch(eventHtml, /href="\/manage\//);
      assert.equal(
        eventHtml.includes('data-event-view="manage"'),
        auth === cookie,
      );
      assert.equal(eventHtml.includes("data-event-save"), auth === cookie);
      assert.doesNotMatch(eventHtml, /data-volunteer-profile-dialog/);
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
    for (const path of ["/volunteers", "/volunteers?approval=awaiting"]) {
      const directory = await get(path);
      assert.equal(directory.status, 200);
      const directoryHtml = await directory.text();
      assert.match(
        directoryHtml,
        /data-volunteer-profile-link[^>]*><span>approved</,
      );
      assert.doesNotMatch(
        directoryHtml,
        /applicant-\d+|data-volunteer-filters|draft-only|account-only/,
      );
    }
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
    await page.goto(`${origin}/volunteers`);
    await expect(page.getByRole("columnheader")).toHaveText(["Name", "Role"]);
    await expect(page.locator("[data-volunteer-results] tbody tr")).toHaveCount(
      2,
    );
    const names = page.locator("[data-volunteer-profile-link]");
    const nameSort = page.locator('[data-volunteer-sort="name"]');
    const roleSort = page.locator('[data-volunteer-sort="role"]');
    await expect(roleSort.locator("..")).toHaveAttribute(
      "aria-sort",
      "ascending",
    );
    await expect(names).toHaveText(["approved", "organizer"]);
    await nameSort.focus();
    await page.keyboard.press("Enter");
    await expect(nameSort.locator("..")).toHaveAttribute(
      "aria-sort",
      "ascending",
    );
    await expect(page).toHaveURL(`${origin}/volunteers?sort=name`);
    await expect(nameSort).toBeFocused();
    await nameSort.click();
    await expect(nameSort.locator("..")).toHaveAttribute(
      "aria-sort",
      "descending",
    );
    await expect(nameSort).toBeFocused();
    await expect(names).toHaveText(["organizer", "approved"]);
    await roleSort.click();
    await expect(roleSort.locator("..")).toHaveAttribute(
      "aria-sort",
      "ascending",
    );
    await expect(names).toHaveText(["approved", "organizer"]);
    await expect(page).toHaveURL(`${origin}/volunteers`);
    await roleSort.click();
    await expect(roleSort.locator("..")).toHaveAttribute(
      "aria-sort",
      "descending",
    );
    await expect(names).toHaveText(["organizer", "approved"]);
    await expect(page).toHaveURL(`${origin}/volunteers?direction=desc`);
    await page.reload();
    await expect(roleSort.locator("..")).toHaveAttribute(
      "aria-sort",
      "descending",
    );
    await page.locator("[data-volunteer-search]").fill("approved");
    await expect(page.locator("[data-volunteer-results] tbody tr")).toHaveCount(
      1,
    );
    await expect(
      page
        .locator("[data-volunteer-results]")
        .getByRole("link", { name: "approved", exact: true }),
    ).toBeVisible();
    await expect(page.locator("[data-volunteer-results] tbody td")).toHaveText([
      "New",
    ]);
    await expect(page.locator('[name="sort"]')).toHaveValue("role");
    await expect(page.locator('[name="direction"]')).toHaveValue("desc");
    const sortedReturn = "/volunteers?q=approved&direction=desc";
    await expect(names).toHaveAttribute(
      "href",
      `/volunteers/approved?returnTo=${encodeURIComponent(sortedReturn)}`,
    );
    await page.locator("[data-volunteer-row] td").first().click();
    await page.getByRole("link", { name: "Back to volunteers" }).click();
    await expect(page).toHaveURL(`${origin}${sortedReturn}`);
    await nameSort.click();
    await expect(nameSort.locator("..")).toHaveAttribute(
      "aria-sort",
      "ascending",
    );
    await page.goBack();
    await expect(roleSort.locator("..")).toHaveAttribute(
      "aria-sort",
      "descending",
    );
    await expect(page.locator("[data-volunteer-search]")).toHaveValue(
      "approved",
    );
    await page.goto(`${origin}/applications?q=applicant&offset=50`);
    const progressSort = page.locator('[data-volunteer-sort="progress"]');
    await expect(progressSort.locator("..")).toHaveAttribute(
      "aria-sort",
      "ascending",
    );
    await progressSort.focus();
    await page.keyboard.press("Enter");
    await expect(progressSort.locator("..")).toHaveAttribute(
      "aria-sort",
      "descending",
    );
    await expect(progressSort).toBeFocused();
    expect(new URL(page.url()).searchParams.has("offset")).toBe(false);
    await progressSort.click();
    await expect(progressSort.locator("..")).toHaveAttribute(
      "aria-sort",
      "ascending",
    );
    await progressSort.click();
    await expect(
      page.getByRole("link", { name: "Next applications" }),
    ).toHaveAttribute(
      "href",
      "/applications?q=applicant&direction=desc&offset=50",
    );
    await page.getByRole("button", { name: /^Ready for review/ }).click();
    await expect(progressSort.locator("..")).toHaveAttribute(
      "aria-sort",
      "descending",
    );
    await expect(
      page.locator('[data-volunteer-search-form] [name="sort"]'),
    ).toHaveValue("progress");
    await nameSort.click();
    await expect(nameSort.locator("..")).toHaveAttribute(
      "aria-sort",
      "ascending",
    );
    await page.goBack();
    await expect(progressSort.locator("..")).toHaveAttribute(
      "aria-sort",
      "descending",
    );
    await page.goForward();
    await expect(nameSort.locator("..")).toHaveAttribute(
      "aria-sort",
      "ascending",
    );
    await page.goto(`${origin}${listPath}`);
    const count = page.locator("[data-awaiting-approval-count]");
    const allCount = page.locator("[data-all-applicants-count]");
    const results = page.locator("[data-volunteer-results]");
    await expect(count).toHaveText("53");
    await expect(allCount).toHaveText("53");
    await expect(results.locator("tbody tr")).toHaveCount(3);
    await expect(results.getByRole("columnheader")).toHaveText([
      "Name",
      "Role",
      "Status",
      "Completed",
    ]);
    const completedTime = results.locator("tbody tr").first().locator("time");
    await expect(completedTime).toHaveAttribute("datetime", completedAt);
    await expect(completedTime).toHaveText(
      formatApplicationCompletedTime(completedAt),
    );
    for (const cell of await results
      .locator("tbody tr")
      .first()
      .locator("th, td")
      .all())
      await expect(cell).toHaveCSS("vertical-align", "middle");
    await expect(results.locator("tbody th [data-volunteer-role]")).toHaveCount(
      0,
    );
    await expect(
      results.locator('tbody td [data-volunteer-role="medic"]'),
    ).toHaveText("Medic");
    await expect(results.locator('[data-state="ready"]').first()).toHaveText(
      "Ready for review",
    );
    await expect(results.locator('[data-state="ready"]').first()).toHaveCSS(
      "color",
      "rgb(74, 222, 128)",
    );
    const filters = page.getByRole("group", { name: "Application approval" });
    const allApplicants = filters.getByRole("button", {
      name: /^All \(\d+\)$/,
    });
    const awaitingApproval = filters.getByRole("button", {
      name: /^Ready for review/,
    });
    await expect(awaitingApproval).toHaveAttribute("aria-pressed", "true");
    await expect(
      page.getByRole("link", { name: "Previous applications" }),
    ).toHaveAttribute("href", /q=applicant&approval=awaiting/);
    const documents: string[] = [];
    page.on("request", (request) => {
      if (request.resourceType() === "document") documents.push(request.url());
    });
    await allApplicants.click();
    await expect(allApplicants).toHaveAttribute("aria-pressed", "true");
    await expect(allApplicants).toBeFocused();
    await expect(results.locator("tbody tr")).toHaveCount(50);
    await expect(page).toHaveURL(`${origin}/applications?q=applicant`);
    await awaitingApproval.click();
    await expect(awaitingApproval).toHaveAttribute("aria-pressed", "true");
    await expect(page).toHaveURL(
      `${origin}/applications?q=applicant&approval=awaiting`,
    );
    await page.goBack();
    await expect(allApplicants).toHaveAttribute("aria-pressed", "true");
    await page.goBack();
    await expect(awaitingApproval).toHaveAttribute("aria-pressed", "true");
    await expect(results.locator("tbody tr")).toHaveCount(3);
    assert.equal(page.url(), `${origin}${listPath}`);
    assert.deepEqual(documents, []);
    const reviewLink = results.locator("[data-volunteer-profile-link]").first();
    const applicationHref = await reviewLink.getAttribute("href");
    assert.ok(applicationHref);
    const profileHref = applicationHref.replace(
      /^\/applications\//,
      "/volunteers/",
    );
    await reviewLink.focus();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(`${origin}${applicationHref}`);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(
      "Alex Jordan Marie de la Cruz",
    );
    await expect(page.locator(".volunteer-panel")).toHaveCount(0);
    const formStep = page.locator(
      '[data-application-mini-step="form"] details',
    );
    await expect(formStep).not.toHaveAttribute("open");
    await expect(
      page.locator('[data-application-mini-step="review"]'),
    ).toHaveCount(0);
    await formStep.locator("summary").click();
    await expect(
      page.getByRole("region", { name: "Submitted answers", exact: true }),
    ).toContainText("PRIVATE QUEUE ANSWER");
    await expect(formStep.locator("h3")).toHaveText([
      "Personal info",
      "Emergency contact",
      "Team interests",
      "Training and safety",
      "Personal statement",
      "Submission details",
    ]);
    await expect(page.locator("[data-patrol-approval]")).toHaveCount(0);
    // Profile editing and patrol controls belong to the volunteer profile.
    await page.goto(`${origin}${profileHref}`);
    await expect(page.locator("[data-volunteer-profile-dialog]")).toHaveCount(
      0,
    );
    await expect(page.locator("[data-volunteer-profile-overview]")).toHaveText(
      "Alex Jordan Marie de la Cruz",
    );
    const profile = page.getByRole("region", {
      name: "Profile",
      exact: true,
    });
    const application = page.getByRole("region", {
      name: "Application",
      exact: true,
    });
    await expect(page.getByRole("tab")).toHaveCount(0);
    const patrolApproval = page.getByRole("region", {
      name: "Patrol Approval",
      exact: true,
    });
    await expect(patrolApproval).toBeVisible();
    await expect(patrolApproval.getByRole("list")).toHaveCount(0);
    const applicationProgress = application.locator(
      "[data-application-progress-mini]",
    );
    await expect(
      applicationProgress.locator(".application-progress-mini-title"),
    ).toHaveText(["Application form", "Naloxone 101", "Application review"]);
    await expect(
      applicationProgress.locator('[data-application-mini-step="form"]'),
    ).toHaveAttribute("data-state", "complete");
    await expect(
      applicationProgress.locator('[data-application-mini-step="naloxone"]'),
    ).toHaveAttribute("data-state", "complete");
    await expect(patrolApproval.getByRole("button")).toHaveCount(0);
    await expect(profile).toHaveCount(0);
    const applicationForm = applicationProgress.locator(
      '[data-application-mini-step="form"] details',
    );
    await expect(applicationForm).not.toHaveAttribute("open");
    await applicationForm.locator("summary").click();
    await expect(
      application.getByText("PRIVATE QUEUE ANSWER", { exact: true }),
    ).toBeVisible();
    await expect(
      applicationProgress.getByText("Ready for review", { exact: true }),
    ).toBeVisible();
    await expect(
      applicationProgress.locator('[data-application-mini-step="review"]'),
    ).toHaveAttribute("data-state", "current");
    await expect(
      applicationProgress.locator(
        '[data-application-mini-step="review"] [data-access-kind="application"]',
      ),
    ).toHaveCount(1);
    await expect(application).toBeVisible();
    await expect(
      page.locator(
        '[data-access-kind="patrol"], [data-organizer-role], [data-access-kind="active"]',
      ),
    ).toHaveCount(0);
    const summary = application.locator(".account-profile-summary");
    await expect(application.getByRole("heading")).toHaveText([
      "Application",
      "Personal info",
      "Emergency contact",
      "Team interests",
      "Training and safety",
      "Personal statement",
      "Submission details",
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
    assert.equal(await auditCount(), 3); // Directory profile, application review, and volunteer profile.
    // Merely reading the application is not review completion.
    await page.getByRole("link", { name: "Back to applications" }).click();
    await expect(count).toHaveText("53");
    await expect(results.locator("tbody tr")).toHaveCount(3);
    // The table scrolls within the viewport on small screens. Modifier clicks on
    // ordinary cells do not hijack the native profile link's browsing behavior.
    await page.setViewportSize({ width: 320, height: 640 });
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth))
      .toBe(320);
    const tableRegion = results.getByRole("region", {
      name: "Application table",
    });
    expect(
      await tableRegion.evaluate(
        (element) => element.scrollWidth > element.clientWidth,
      ),
    ).toBe(true);
    await results
      .locator("tbody tr")
      .first()
      .locator("td")
      .first()
      .click({ modifiers: ["Control"] });
    await expect(page).toHaveURL(
      `${origin}/applications?q=applicant&approval=awaiting&offset=50`,
    );
    await page.setViewportSize({ width: 1280, height: 900 });
    await results.locator("tbody tr").first().locator("td").first().click();
    await expect(page).toHaveURL(`${origin}${applicationHref}`);
    await page.goto(`${origin}${profileHref}`);
    await DB.prepare(
      "UPDATE profile SET naloxone_completed_at=NULL WHERE user_id='applicant-50'",
    ).run();
    await page.reload();
    await expect(
      applicationProgress.locator('[data-application-mini-step="naloxone"]'),
    ).toHaveAttribute("data-state", "current");
    await expect(
      applicationProgress.getByText("Ready for review", { exact: true }),
    ).toHaveCount(0);
    const inProgressList = await get("/applications?q=applicant-50");
    const inProgressHtml = await inProgressList.text();
    assert.match(inProgressHtml, /data-state="in-progress">In Progress</);
    assert.match(inProgressHtml, /data-awaiting-approval-count>0</);
    const reviewQueue = await get(
      "/applications?q=applicant-50&approval=awaiting",
    );
    assert.doesNotMatch(await reviewQueue.text(), /data-volunteer-row/);
    await page.goto(`${origin}/applications?q=applicant-50`);
    await expect(results.locator('[data-state="in-progress"]')).toHaveText(
      "In Progress",
    );
    await expect(results.locator('[data-state="in-progress"]')).toHaveCSS(
      "color",
      "rgb(212, 212, 216)",
    );
    await expect(results.locator("tbody time")).toHaveCount(0);
    await page.goto(`${origin}${profileHref}`);
    await DB.prepare(
      "UPDATE profile SET naloxone_completed_at=0 WHERE user_id='applicant-50'",
    ).run();
    await page.reload();
    await expect(
      applicationProgress.getByText("Ready for review", { exact: true }),
    ).toBeVisible();
    await expect(
      applicationProgress.locator('[data-application-mini-step="naloxone"]'),
    ).toHaveAttribute("data-state", "complete");
    await expect(
      applicationProgress.locator('[data-application-mini-step="review"]'),
    ).toHaveAttribute("data-state", "current");
    await page
      .getByRole("button", { name: "Approve application", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Save without email", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Revoke application approval" }),
    ).toBeEnabled();
    await expect(application).toBeVisible();
    await expect(profile).toBeVisible();
    await expect(patrolApproval.locator("[data-patrol-status]")).toHaveText(
      "Awaiting patrol approval",
    );
    await expect(
      patrolApproval.locator("[data-orientation-status]"),
    ).toHaveText("Orientation not completed");
    await expect(
      applicationProgress.locator('[data-state="complete"]'),
    ).toHaveCount(3);
    await expect(
      patrolApproval.getByRole("button", {
        name: "Approve for patrols",
        exact: true,
      }),
    ).toBeEnabled();
    await expect(profile.getByRole("heading").first()).toHaveText("Profile");
    await expect(
      applicationProgress.locator('[data-application-mini-step="review"]'),
    ).toContainText("Approved by");
    const submittedDetails = applicationForm;
    await expect(submittedDetails).not.toHaveAttribute("open");
    await submittedDetails.locator("summary").click();
    await expect(submittedDetails).toHaveAttribute("open");
    await expect(
      application.getByText("PRIVATE QUEUE ANSWER", { exact: true }),
    ).toBeVisible();
    // An organizer can approve patrols before any orientation is booked, without
    // recording attendance that has not happened.
    const approvePatrols = patrolApproval.getByRole("button", {
      name: "Approve for patrols",
      exact: true,
    });
    await approvePatrols.click();
    await page
      .getByRole("button", { name: "Save without email", exact: true })
      .click();
    await expect(patrolApproval.locator("[data-patrol-status]")).toHaveText(
      "Patrol access approved",
    );
    await expect(
      patrolApproval.locator("[data-patrol-access-change]"),
    ).toContainText("Approved by");
    await expect(
      patrolApproval.locator("[data-orientation-status]"),
    ).toHaveText("Orientation not completed");
    assert.equal(
      await DB.prepare(
        "SELECT count(*) AS n FROM orientation_completion WHERE user_id='applicant-50'",
      ).first("n"),
      0,
    );
    await patrolApproval
      .getByRole("button", { name: "Revoke patrol approval", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Save without email", exact: true })
      .click();
    await expect(approvePatrols).toBeEnabled();
    await expect(
      patrolApproval.locator("[data-patrol-access-change]"),
    ).toContainText("Revoked by");
    await DB.batch([
      DB.prepare(
        `INSERT INTO event (id,type,includes_orientation,starts_at,meeting_point,spots,created_by,created_at,updated_at)
        VALUES ('queue-orientation','patrol',1,?,'Queue orientation',8,'organizer',0,0)`,
      ).bind(Date.now() + 86_400_000),
      DB.prepare(
        "INSERT INTO signup (id,event_id,user_id,created_at,updated_at) VALUES ('queue-signup','queue-orientation','applicant-50',0,0)",
      ),
    ]);
    await page.reload();
    await expect(patrolApproval).toContainText("Queue orientation");
    await expect(
      patrolApproval.getByRole("button", {
        name: "Approve for patrols",
        exact: true,
      }),
    ).toBeEnabled();
    await DB.prepare(
      "UPDATE event SET starts_at=0 WHERE id='queue-orientation'",
    ).run();
    await DB.prepare(
      `UPDATE profile SET teams='["medic"]' WHERE user_id='applicant-50'`,
    ).run();
    await DB.prepare(
      "INSERT INTO orientation_completion (id,user_id,event_id,marked_by,marked_at) VALUES ('queue-completion','applicant-50','queue-orientation','organizer',1)",
    ).run();
    await page.reload();
    await expect(
      patrolApproval.locator("[data-orientation-status]"),
    ).toHaveText("Orientation completed");
    await expect(
      patrolApproval.locator("[data-orientation-event]"),
    ).toContainText("Queue orientation");
    await expect(approvePatrols).toBeEnabled();
    await expect(patrolApproval.getByRole("button")).toHaveCount(1);
    for (const width of [320, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth),
      ).toBe(width);
    }
    await approvePatrols.click();
    await page
      .getByRole("button", { name: "Cancel change", exact: true })
      .click();
    await expect(approvePatrols).toBeEnabled();
    assert.equal(
      await DB.prepare(
        "SELECT count(*) AS n FROM orientation_completion WHERE user_id='applicant-50'",
      ).first("n"),
      1,
    );
    await approvePatrols.click();
    await page
      .getByRole("button", { name: "Save without email", exact: true })
      .click();
    await expect(patrolApproval.locator("[data-patrol-status]")).toHaveText(
      "Patrol access approved",
    );
    await expect(
      patrolApproval.locator("[data-patrol-access-change]"),
    ).toContainText("Approved by");
    await expect(
      patrolApproval.locator("[data-patrol-access-change] time"),
    ).toHaveAttribute("datetime", /T.*Z$/);
    await expect(
      page.locator('.volunteer-profile-controls [data-access-kind="patrol"]'),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Revoke patrol approval", exact: true }),
    ).toBeFocused();
    const recorded = await DB.prepare(
      "SELECT v.patrol_approved, o.marked_by, o.marked_at, v.approved_at FROM volunteer_status v JOIN orientation_completion o ON o.user_id=v.user_id WHERE v.user_id='applicant-50'",
    ).first();
    assert.equal(recorded?.patrol_approved, 1);
    assert.equal(recorded?.marked_by, "organizer");
    assert.equal(recorded?.marked_at, 1);
    assert.ok(Number(recorded?.approved_at) > 1);
    const approvedDirectory = await get("/volunteers?q=applicant-50");
    assert.match(
      await approvedDirectory.text(),
      /data-volunteer-profile-link[^>]*><span>applicant-50 d\.</,
    );
    await expect(
      patrolApproval.locator("[data-orientation-event]"),
    ).toContainText("Queue orientation");
    assert.equal(
      await DB.prepare(
        "SELECT count(*) AS n FROM event_notification WHERE user_id='applicant-50'",
      ).first("n"),
      0,
    );
    await page.getByRole("link", { name: "Back to applications" }).click();
    await expect(count).toHaveText("52");
    await expect(allCount).toHaveText("52");
    await expect(results.locator("tbody tr")).toHaveCount(2);
    // Normal full-page links retain exactly the same list context.
    await page.goto(`${origin}${profileHref}`);
    await expect(
      page.getByRole("link", { name: "Back to applications" }),
    ).toHaveAttribute(
      "href",
      "/applications?q=applicant&approval=awaiting&offset=50",
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
    await page.getByRole("link", { name: "Back to applications" }).click();
    await page.waitForLoadState("load");
    await expect(count).toHaveText("53");
    await expect(results.locator("tbody tr")).toHaveCount(3);
    const search = page.locator("[data-volunteer-search]");
    await search.fill("applicant-52");
    await expect(results.locator("tbody tr")).toHaveCount(1);
    await expect(count).toHaveText("1");
    await expect(allCount).toHaveText("1");
    expect(new URL(page.url()).searchParams.get("approval")).toBe("awaiting");
    expect(new URL(page.url()).searchParams.has("offset")).toBe(false);
    await search.fill("approved");
    await expect(results.locator("tbody tr")).toHaveCount(0);
    await expect(count).toHaveText("0");
    await expect(allCount).toHaveText("0");
    await allApplicants.click();
    await expect(results.locator("tbody tr")).toHaveCount(0);
    await expect(count).toHaveText("0");
    await expect(allCount).toHaveText("0");
    await expect(
      results.getByRole("link", { name: "approved", exact: true }),
    ).toHaveCount(0);
    await expect(page).toHaveURL(`${origin}/applications?q=approved`);
    await page.goBack();
    await expect(awaitingApproval).toHaveAttribute("aria-pressed", "true");
    await expect(results.locator("tbody tr")).toHaveCount(0);
    await expect(search).toHaveValue("approved");
    await search.fill("no match");
    await expect(
      results.getByText("No applications ready for review match your search."),
    ).toBeVisible();
    await expect(count).toHaveText("0");
    await expect(allCount).toHaveText("0");
    await search.fill("applicant");
    await expect(results.locator("tbody tr")).toHaveCount(50);
    await page.getByRole("link", { name: "Next applications" }).click();
    await expect(results.locator("tbody tr")).toHaveCount(3);
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
    await plain.goto(`${origin}${listPath}&sort=progress&direction=desc`);
    await plain.locator("[data-volunteer-search]").fill("applicant-52");
    await plain.getByRole("button", { name: "Search", exact: true }).click();
    await expect(
      plain.locator("[data-volunteer-results] tbody tr"),
    ).toHaveCount(1);
    expect(new URL(plain.url()).searchParams.get("approval")).toBe("awaiting");
    expect(new URL(plain.url()).searchParams.get("sort")).toBe("progress");
    expect(new URL(plain.url()).searchParams.get("direction")).toBe("desc");
    expect(new URL(plain.url()).searchParams.has("offset")).toBe(false);
    await plain.getByRole("button", { name: "All (1)", exact: true }).click();
    expect(new URL(plain.url()).searchParams.get("q")).toBe("applicant-52");
    await expect(
      plain.getByRole("button", { name: "All (1)", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    await plain.getByRole("button", { name: "Ready for review (1)" }).click();
    expect(new URL(plain.url()).searchParams.get("sort")).toBe("progress");
    expect(new URL(plain.url()).searchParams.get("direction")).toBe("desc");
    await plain.locator("[data-volunteer-profile-link]").click();
    await expect(
      plain.getByRole("heading", { name: "Profile", exact: true }),
    ).toHaveCount(0);
    await plain.locator('[data-application-mini-step="form"] summary').click();
    await expect(
      plain.getByRole("region", { name: "Submitted answers", exact: true }),
    ).toBeVisible();
    await expect(
      plain.getByRole("link", { name: "Back to applications" }),
    ).toHaveAttribute(
      "href",
      "/applications?q=applicant-52&approval=awaiting&direction=desc",
    );
    await plain.goto(`${origin}/volunteers?q=approved&sort=name&offset=50`);
    await plain.locator('[data-volunteer-sort="role"]').click();
    await expect(
      plain.locator("[data-volunteer-results] tbody tr"),
    ).toHaveCount(1);
    expect(new URL(plain.url()).searchParams.has("offset")).toBe(false);
    await plain.locator('[data-volunteer-sort="role"]').click();
    await plain.locator("[data-volunteer-search]").fill("organizer");
    await plain.getByRole("button", { name: "Search", exact: true }).click();
    expect(new URL(plain.url()).searchParams.get("sort")).toBe("role");
    expect(new URL(plain.url()).searchParams.get("direction")).toBe("desc");
    await expect(plain.locator("[data-volunteer-profile-link]")).toHaveText(
      "organizer",
    );
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
    await expect(allCount).toHaveText("50");
    await expect(results.locator("tbody tr")).toHaveCount(0);
    await expect(
      results.getByText(
        "No applications ready for review on this page. Return to the previous page.",
      ),
    ).toBeVisible();
    expect(page.url()).toBe(restoredListUrl);
    await page.getByRole("link", { name: "Previous applications" }).click();
    await expect(results.locator("tbody tr")).toHaveCount(50);
    expect(new URL(page.url()).searchParams.get("approval")).toBe("awaiting");
    await DB.prepare(
      "UPDATE volunteer_status SET registration_approved=1",
    ).run();
    await page.goto(`${origin}/applications?approval=awaiting`);
    await expect(count).toHaveText("0");
    await expect(allCount).toHaveText("0");
    await expect(
      results.getByText("No applications are ready for review."),
    ).toBeVisible();

    const postAction = (body: object, auth = cookie, requestOrigin = origin) =>
      worker.fetch(`${origin}/api/v1/organizer/action`, {
        method: "POST",
        headers: {
          cookie: auth,
          origin: requestOrigin,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      });
    const status = () =>
      DB.prepare(
        "SELECT * FROM volunteer_status WHERE user_id='applicant-50'",
      ).first<{
        updated_at: number;
        application_rejection_reason: string | null;
      }>();
    const version = (await status())!.updated_at;
    const rejection = {
      action: "reject-application",
      userId: "applicant-50",
      version,
      reason:
        "We cannot accommodate your availability. <Please contact us>\nThank you for applying.",
    };
    // Rejection is a pending-application decision, not a shortcut for revoking approval.
    assert.equal((await postAction(rejection)).status, 409);
    await DB.prepare(
      "UPDATE volunteer_status SET registration_approved=0 WHERE user_id='applicant-50'",
    ).run();
    const beforeRejection = await status();
    assert.equal((await postAction(rejection, "")).status, 401);
    assert.equal((await postAction(rejection, volunteerCookie)).status, 403);
    assert.equal(
      (await postAction(rejection, cookie, "https://evil.example.org")).status,
      403,
    );
    for (const reason of ["", " \n\t ", "x".repeat(2001)])
      assert.equal((await postAction({ ...rejection, reason })).status, 400);
    assert.equal(
      (await postAction({ ...rejection, version: version + 1 })).status,
      409,
    );
    assert.deepEqual(await status(), beforeRejection);
    const applicantCookie = await signIn("applicant-50");
    const beforeDecisionVersion = await (
      await get("/api/v1/events/version", applicantCookie)
    ).text();

    await page.goto(`${origin}/volunteers/applicant-50`);
    await page.getByText("Reject application", { exact: true }).click();
    await page
      .getByLabel("Reason for rejection")
      .fill(`  ${rejection.reason}  `);
    await page
      .getByRole("button", {
        name: "Reject application and email reason",
        exact: true,
      })
      .click();
    await expect(page.locator("[data-application-rejection]")).toHaveText(
      `Reason: ${rejection.reason}`,
    );
    await expect(
      page.locator('[data-application-mini-step="review"]'),
    ).toHaveAttribute("data-state", "rejected");
    const feedback = page.locator("[data-action-email-feedback]");
    await expect(feedback).toBeVisible();
    await expect(feedback).toContainText("Application rejected.");
    await expect(feedback).toContainText("could not be sent");
    const savedRejection = await status();
    assert.equal(
      savedRejection!.application_rejection_reason,
      rejection.reason,
    );
    const queued = await DB.prepare(
      "SELECT operation_id, delivery_to, body FROM event_notification WHERE user_id='applicant-50' AND subject='Your volunteer application was not approved'",
    ).all<{ operation_id: string; delivery_to: string; body: string }>();
    assert.equal(queued.results.length, 1);
    assert.equal(queued.results[0].delivery_to, "applicant-50@example.org");
    assert.ok(queued.results[0].body.includes(rejection.reason));
    const decisionAudit = await DB.prepare(
      "SELECT changed_fields FROM audit_log WHERE id=? AND action='application_rejected'",
    )
      .bind(queued.results[0].operation_id)
      .first<string>("changed_fields");
    assert.equal(decisionAudit, '["applicationRejectionReason"]');
    // Retrying only email cannot repeat the decision or overwrite its reason.
    await feedback.getByRole("button", { name: "Retry email only" }).click();
    await expect(
      feedback.getByRole("button", { name: "Retry email only" }),
    ).toBeEnabled();
    assert.deepEqual(await status(), savedRejection);
    assert.equal((await postAction(rejection)).status, 409);
    assert.equal(
      await DB.prepare(
        "SELECT count(*) AS n FROM event_notification WHERE operation_id=?",
      )
        .bind(queued.results[0].operation_id)
        .first<number>("n"),
      1,
    );
    await feedback.locator(".dialog-close").click();
    await page
      .getByRole("button", { name: "Approve application", exact: true })
      .focus();
    await page.goto(`${origin}/applications?approval=awaiting&q=applicant-50`);
    await expect(count).toHaveText("0");
    await page.getByRole("button", { name: "All (1)", exact: true }).click();
    await expect(results).toContainText("Rejected");
    assert.notEqual(
      await (await get("/api/v1/events/version", applicantCookie)).text(),
      beforeDecisionVersion,
    );
    for (const path of ["/volunteer", "/volunteer/account"]) {
      const decision = await get(path, applicantCookie);
      assert.equal(decision.status, 200);
      const decisionHtml = await decision.text();
      assert.match(decisionHtml, /Application rejected/);
      assert.ok(decisionHtml.includes("&lt;Please contact us&gt;"));
      assert.equal(
        await page.evaluate(
          (html) =>
            new DOMParser()
              .parseFromString(html, "text/html")
              .querySelector("please") !== null,
          decisionHtml,
        ),
        false,
      );
    }
    assert.ok(
      !(
        await (await get("/volunteer/account", volunteerCookie)).text()
      ).includes("We cannot accommodate your availability."),
    );
    const approvedAgain = await postAction({
      action: "status",
      userId: "applicant-50",
      version: savedRejection!.updated_at,
      active: true,
      applicationApproved: true,
      patrolApproved: false,
    });
    assert.equal(approvedAgain.status, 200, await approvedAgain.clone().text());
    assert.equal((await status())!.application_rejection_reason, null);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    await server.close();
  }
});
