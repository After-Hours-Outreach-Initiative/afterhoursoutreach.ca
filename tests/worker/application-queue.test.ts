import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { test } from "vitest";
import { chromium, expect } from "@playwright/test";
import { createTestHarness } from "wrangler";
import { createSignInOTP } from "../helpers/email-otp";
import { expectDirectorySort, sortDirectory } from "../helpers/directory-sort";
import {
  formatApplicationCompletedTime,
  formatApplicationSubmittedTime,
} from "../../src/data/application";

test("organizers review pending and approved applications with persistent list context", async () => {
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
    // Status sorting puts newest completions first, ahead of the detailed subject.
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
    const listPath = "/applications?q=applicant&approval=awaiting";
    const anonymous = await get(listPath, "");
    assert.equal(anonymous.status, 302);
    assert.equal(
      new URL(anonymous.headers.get("location")!, origin).searchParams.get(
        "returnTo",
      ),
      listPath,
    );
    for (const path of [
      listPath,
      "/applications/approved",
      "/volunteers",
      "/volunteers/applicant-50",
    ])
      assert.equal((await get(path, volunteerCookie)).status, 403);
    for (const path of [
      "/register",
      "/volunteer/register",
      "/patrols",
      "/volunteer/volunteers?approval=awaiting&q=applicant&offset=50",
      "/volunteer/volunteers/applicant-50",
      "/manage/volunteers?approval=awaiting&q=applicant&offset=50",
      "/manage/volunteers/applicant-50",
      "/manage/applications?approval=awaiting&q=applicant&offset=50",
      "/manage/events?type=orientation&occurrence=a%2Fb",
    ]) {
      for (const auth of ["", cookie]) {
        const response = await get(path, auth);
        assert.equal(response.status, 404, path);
        assert.equal(response.headers.get("location"), null, path);
      }
    }
    const eventPath = "/events?type=orientation&occurrence=a%2Fb";
    const introduction = await get("/volunteer?type=orientation", "");
    assert.equal(introduction.status, 200);
    assert.match(await introduction.text(), /data-return-to="\/volunteer"/);
    for (const auth of ["", volunteerCookie])
      assert.doesNotMatch(
        await (await get("/about", auth)).text(),
        /data-header-application-count/,
      );
    await DB.prepare(
      "UPDATE user SET two_factor_enabled=1 WHERE id='organizer'",
    ).run();
    assert.doesNotMatch(
      await (await get("/about")).text(),
      /data-header-application-count/,
    );
    await DB.prepare(
      "UPDATE user SET two_factor_enabled=0 WHERE id='organizer'",
    ).run();
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
      const signIn = await get("/volunteer/sign-in?returnTo=%2Fevents", auth);
      assert.equal(signIn.status, 302);
      assert.equal(signIn.headers.get("location"), "/events");
      const landing = await get(
        "/volunteer?type=orientation&occurrence=a%2Fb",
        auth,
      );
      if (auth === cookie) {
        assert.equal(landing.status, 302);
        assert.equal(
          landing.headers.get("location"),
          "/events?type=orientation&occurrence=a%2Fb",
        );
      } else {
        assert.equal(landing.status, 200);
        const landingHtml = await landing.text();
        assert.match(landingHtml, /data-event-path="\/volunteer"/);
        assert.match(landingHtml, /data-event-access="true"/);
        assert.doesNotMatch(landingHtml, /data-event-view-link/);
      }
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
      assert.equal(
        [...eventHtml.matchAll(/data-header-application-count/g)].length,
        auth === cookie ? 2 : 0,
      );
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
    assert.match(html, /data-awaiting-approval-count[^>]*>53</);
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
        /applicant-\d+|data-filter-menu="approval"|draft-only|account-only/,
      );
    }
    const auditCount = () =>
      DB.prepare(
        "SELECT count(*) AS n FROM audit_log WHERE action='profile_viewed'",
      ).first<number>("n");
    assert.equal(await auditCount(), 0);

    const context = await browser.newContext();
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
    for (const [id, destination] of [
      ["organizer", "/events"],
      ["approved", "/events"],
      ["applicant-00", "/volunteer"],
    ]) {
      await context.clearCookies();
      const proof = await createSignInOTP(DB, secret, `${id}@example.org`);
      await page.goto(
        `${origin}/volunteer/sign-in/complete#${new URLSearchParams(proof)}`,
      );
      await page.getByLabel("Six-digit code").fill(proof.otp);
      await page.getByRole("button", { name: "Sign in with code" }).click();
      await expect(page).toHaveURL(`${origin}${destination}`);
      await expect(page.locator("[data-event-browser]")).toBeVisible();
    }
    await context.clearCookies();
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
    await page.goto(`${origin}/volunteers`);
    const headerCount = page.locator("[data-header-application-count]");
    await expect(headerCount).toHaveText([
      "53 ready for review",
      "53 ready for review",
    ]);
    for (const width of [1280, 375]) {
      await page.setViewportSize({ width, height: 900 });
      if (width < 1024)
        await page.getByRole("button", { name: "Open navigation" }).click();
      const navigation = page.getByRole("navigation", {
        name: width < 1024 ? "Mobile navigation" : "Primary navigation",
        exact: true,
      });
      await expect(
        navigation.getByRole("link", {
          name: "Applications 53 ready for review",
          exact: true,
        }),
      ).toBeVisible();
    }
    await page.setViewportSize({ width: 1280, height: 900 });
    await expect(page.getByRole("list", { name: "Volunteers" })).toBeVisible();
    await expect(
      page.locator("[data-volunteer-results] [data-volunteer-row]"),
    ).toHaveCount(2);
    const names = page.locator("[data-volunteer-profile-link]");
    // The default role order puts new volunteers first and organizers last.
    await expect(names).toHaveText(["approved", "organizer"]);
    await expect(
      page.locator('.directory-item-name > [data-volunteer-role="organizer"]'),
    ).toHaveText("Organizer");
    await sortDirectory(page, "name", "asc");
    await expectDirectorySort(page, "name", "asc");
    await expect(page).toHaveURL(`${origin}/volunteers?sort=name`);
    await sortDirectory(page, "name", "desc");
    await expectDirectorySort(page, "name", "desc");
    await expect(names).toHaveText(["organizer", "approved"]);
    await expect(page).toHaveURL(
      `${origin}/volunteers?sort=name&direction=desc`,
    );
    await page.reload();
    await expectDirectorySort(page, "name", "desc");
    await page.locator("[data-volunteer-search]").fill("approved");
    await expect(
      page.locator("[data-volunteer-results] [data-volunteer-row]"),
    ).toHaveCount(1);
    await expect(
      page
        .locator("[data-volunteer-results]")
        .getByRole("link", { name: "approved", exact: true }),
    ).toBeVisible();
    await expect(
      page.locator(
        '[data-volunteer-results] .directory-item-name > [data-volunteer-role="new-volunteer"]',
      ),
    ).toHaveText("New");
    await expectDirectorySort(page, "name", "desc");
    const sortedReturn = "/volunteers?q=approved&sort=name&direction=desc";
    await expect(names).toHaveAttribute(
      "href",
      `/volunteers/approved?returnTo=${encodeURIComponent(sortedReturn)}`,
    );
    await page
      .locator("[data-volunteer-row]")
      .click({ position: { x: 2, y: 2 } });
    await page.getByRole("link", { name: "Back to volunteers" }).click();
    await expect(page).toHaveURL(`${origin}${sortedReturn}`);
    await sortDirectory(page, "name", "asc");
    await expectDirectorySort(page, "name", "asc");
    await page.goBack();
    await expectDirectorySort(page, "name", "desc");
    await expect(page.locator("[data-volunteer-search]")).toHaveValue(
      "approved",
    );
    await page.goto(`${origin}/applications?q=applicant&offset=50`);
    await expectDirectorySort(page, "progress", "asc");
    await sortDirectory(page, "progress", "desc");
    await expectDirectorySort(page, "progress", "desc");
    expect(new URL(page.url()).searchParams.has("offset")).toBe(false);
    await expect(
      page.getByRole("link", { name: /^(Next|Previous) applications$/ }),
    ).toHaveCount(0);
    await expect(
      page.locator("[data-volunteer-results] [data-volunteer-row]"),
    ).toHaveCount(53);
    // Filtering keeps the current sort.
    await page.getByRole("button", { name: /^Status/ }).click();
    await page
      .locator('[data-filter-menu="approval"] input[value="awaiting"]')
      .check();
    await page
      .locator('[data-filter-menu="approval"]')
      .getByRole("button", { name: "Apply" })
      .click();
    await expect(page).toHaveURL(/approval=awaiting/);
    await expectDirectorySort(page, "progress", "desc");
    await sortDirectory(page, "name", "asc");
    await expectDirectorySort(page, "name", "asc");
    await page.goBack();
    await expectDirectorySort(page, "progress", "desc");
    await page.goForward();
    await expectDirectorySort(page, "name", "asc");
    await page.goto(`${origin}${listPath}`);
    const count = page.locator("[data-awaiting-approval-count]");
    const results = page.locator("[data-volunteer-results]");
    // Status filters are a menu; its counts add up to every matching applicant.
    const statusMenu = page.locator('[data-filter-menu="approval"]');
    const statusTrigger = page.getByRole("button", { name: /^Status/ });
    const readyInput = statusMenu.locator('input[value="awaiting"]');
    const expectAllCount = (total: number) =>
      expect
        .poll(async () =>
          (
            await statusMenu.locator("[data-filter-count]").allTextContents()
          ).reduce((sum, value) => sum + Number(value.trim()), 0),
        )
        .toBe(total);
    const chooseStatuses = async (values: string[]) => {
      await statusTrigger.click();
      await statusMenu.getByRole("button", { name: "Clear" }).click();
      for (const value of values)
        await statusMenu.locator(`input[value="${value}"]`).check();
      await statusMenu.getByRole("button", { name: "Apply" }).click();
      await expect(statusMenu).toBeHidden();
    };
    await expect(count).toHaveText("53");
    await expectAllCount(53);
    await expect(results.locator("[data-volunteer-row]")).toHaveCount(53);
    await expect(
      results.getByRole("list", { name: "Applications" }).getByRole("listitem"),
    ).toHaveCount(53);
    const detailedRow = results.locator("[data-volunteer-row]").filter({
      has: page.locator(
        '[data-volunteer-profile-link][href^="/applications/applicant-50?"]',
      ),
    });
    const completedTime = detailedRow.locator("time");
    await expect(completedTime).toHaveAttribute("datetime", completedAt);
    await expect(completedTime).toHaveText(
      formatApplicationCompletedTime(completedAt),
    );
    for (const cell of await detailedRow.locator("th, td").all())
      await expect(cell).toHaveCSS("vertical-align", "middle");
    await expect(
      results.locator(".directory-item-meta [data-volunteer-role]"),
    ).toHaveCount(0);
    await expect(
      results.locator('.directory-item-name > [data-volunteer-role="medic"]'),
    ).toHaveText("Medic");
    await expect(results.locator('[data-state="ready"]').first()).toHaveText(
      "Ready for review",
    );
    await expect(results.locator('[data-state="ready"]').first()).toHaveCSS(
      "color",
      "rgb(74, 222, 128)",
    );
    await expect(readyInput).toBeChecked();
    await expect(
      page.getByRole("link", { name: /^(Next|Previous) applications$/ }),
    ).toHaveCount(0);
    const documents: string[] = [];
    page.on("request", (request) => {
      if (request.resourceType() === "document") documents.push(request.url());
    });
    await chooseStatuses([]);
    await expect(page).toHaveURL(`${origin}/applications?q=applicant`);
    await expect(readyInput).not.toBeChecked();
    await expect(statusTrigger).toBeFocused();
    await expect(results.locator("[data-volunteer-row]")).toHaveCount(53);
    await chooseStatuses(["awaiting"]);
    await expect(page).toHaveURL(
      `${origin}/applications?q=applicant&approval=awaiting`,
    );
    await expect(readyInput).toBeChecked();
    await page.goBack();
    await expect(readyInput).not.toBeChecked();
    await page.goBack();
    await expect(readyInput).toBeChecked();
    await expect(results.locator("[data-volunteer-row]")).toHaveCount(53);
    assert.equal(page.url(), `${origin}${listPath}`);
    assert.deepEqual(documents, []);
    const reviewLink = detailedRow.locator("[data-volunteer-profile-link]");
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
    const submittedSummary = formStep.locator(".account-profile-summary");
    for (const label of [
      "Highest medical certification or licence",
      "Additional certification answer",
      "Certification expiry date",
      "Other training and experience",
      "Other relevant training",
      "Other relevant experience",
    ])
      await expect(
        submittedSummary.getByText(label, { exact: true }),
      ).toHaveCount(0);
    const answer = (label: string) =>
      submittedSummary
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
    await expect(page.locator("[data-patrol-approval]")).toHaveCount(0);
    // Profile editing and patrol controls belong to the volunteer profile.
    await page.goto(`${origin}${profileHref}`);
    await expect(page.locator("[data-volunteer-profile-dialog]")).toHaveCount(
      0,
    );
    await expect(
      page.locator("[data-volunteer-profile-overview] h2"),
    ).toHaveText("Alex Jordan Marie de la Cruz");
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
    await expect(applicationForm).toHaveCount(0);
    await expect(
      application.getByText("PRIVATE QUEUE ANSWER", { exact: true }),
    ).toHaveCount(0);
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
    ).toHaveCount(0);
    await expect(
      application.getByRole("link", { name: "View application", exact: true }),
    ).toHaveAttribute("href", "/applications/applicant-50");
    await expect(applicationProgress.locator("time")).toHaveCount(2);
    await expect(application).toBeVisible();
    await expect(
      page.locator(
        '[data-access-kind="patrol"], [data-organizer-role], [data-access-kind="active"]',
      ),
    ).toHaveCount(0);
    await expect(application.getByRole("heading")).toHaveText(["Application"]);
    assert.equal(await auditCount(), 3); // Directory profile, application review, and volunteer profile.
    // Merely reading the application is not review completion.
    await page.getByRole("link", { name: "Back to applications" }).click();
    await expect(count).toHaveText("53");
    await expect(results.locator("[data-volunteer-row]")).toHaveCount(53);
    // The list fits small screens without any horizontal scrolling.
    await page.setViewportSize({ width: 320, height: 640 });
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth))
      .toBe(320);
    expect(
      await results
        .getByRole("list", { name: "Applications" })
        .evaluate((element) => element.scrollWidth > element.clientWidth),
    ).toBe(false);
    await page.setViewportSize({ width: 1280, height: 900 });
    await detailedRow.click({ position: { x: 2, y: 2 } });
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
    assert.match(inProgressHtml, /data-awaiting-approval-count[^>]*>0</);
    assert.match(
      inProgressHtml,
      /data-header-application-count[^>]*>(?:<[^>]*>)*52</,
    );
    const reviewQueue = await get(
      "/applications?q=applicant-50&approval=awaiting",
    );
    assert.doesNotMatch(
      (await reviewQueue.text()).replace(/<template[\s\S]*?<\/template>/g, ""),
      /data-volunteer-row/,
    );
    await page.goto(`${origin}/applications?q=applicant-50`);
    await expect(results.locator('[data-state="in-progress"]')).toHaveText(
      "In Progress",
    );
    await expect(results.locator('[data-state="in-progress"]')).toHaveCSS(
      "color",
      "rgb(212, 212, 216)",
    );
    await expect(results.locator("time")).toHaveCount(0);
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
    await page.goto(`${origin}${applicationHref}`);
    await page.locator('[data-application-mini-step="form"] summary').click();
    const documentsBeforeApproval = documents.length;
    // Access decisions always email; tests have no email transport.
    const closeEmailFeedback = async () => {
      const feedback = page.locator("[data-action-email-feedback][open]");
      await expect(feedback).toBeVisible();
      await feedback.locator(".dialog-close").click();
      await expect(feedback).toHaveCount(0);
    };
    await page
      .getByRole("button", { name: "Approve application", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Approve and send email", exact: true })
      .click();
    await closeEmailFeedback();
    await expect(
      page.getByRole("button", { name: "Revoke application approval" }),
    ).toBeEnabled();
    await expect(page).toHaveURL(`${origin}${applicationHref}`);
    assert.equal(documents.length, documentsBeforeApproval);
    const approvedReview = page.locator(
      '[data-application-review] [data-application-mini-step="review"]',
    );
    await expect(approvedReview).toHaveAttribute("data-state", "complete");
    await expect(headerCount).toHaveText([
      "52 ready for review",
      "52 ready for review",
    ]);
    await expect(
      approvedReview.locator("[data-application-approved-by] dd"),
    ).toHaveText("organizer");
    await expect(
      approvedReview.locator("[data-volunteer-profile-link]"),
    ).toHaveAttribute("href", "/volunteers/organizer");
    await expect(approvedReview.locator("time")).toHaveAttribute(
      "datetime",
      /T.*Z$/,
    );
    await expect(
      page.locator('[data-application-mini-step="form"] details'),
    ).toHaveAttribute("open");
    await expect(
      page.locator('access-decision[data-decision="reject"]'),
    ).toHaveCount(0);
    // The dedicated application route renders the same approved review on reload.
    await page.reload();
    await expect(
      approvedReview.locator("[data-application-approved-by] dd"),
    ).toHaveText("organizer");
    await page.goto(`${origin}${profileHref}`);
    await expect(application).toBeVisible();
    await expect(profile).toBeVisible();
    await expect(patrolApproval.locator("[data-patrol-status]")).toHaveText(
      "Awaiting patrol approval",
    );
    await expect(
      patrolApproval.locator("[data-orientation-status]"),
    ).toHaveCount(0);
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
    ).toContainText("Approved");
    await expect(applicationForm).toHaveCount(0);
    await expect(
      application.getByText("PRIVATE QUEUE ANSWER", { exact: true }),
    ).toHaveCount(0);
    // An organizer can approve patrols before any orientation is booked.
    const approvePatrols = patrolApproval.getByRole("button", {
      name: "Approve for patrols",
      exact: true,
    });
    await approvePatrols.click();
    await page
      .getByRole("button", { name: "Approve and send email", exact: true })
      .click();
    await closeEmailFeedback();
    await expect(patrolApproval.locator("[data-patrol-status]")).toHaveCount(0);
    await expect(
      patrolApproval.locator("[data-patrol-access-change]"),
    ).toContainText("Approved by");
    await expect(
      patrolApproval.locator("[data-patrol-access-change] dd").first(),
    ).toHaveText("organizer");
    await expect(
      patrolApproval.locator("[data-volunteer-profile-link]"),
    ).toHaveAttribute("href", "/volunteers/organizer");
    await expect(
      patrolApproval.locator("[data-orientation-status]"),
    ).toHaveCount(0);
    await patrolApproval
      .getByRole("button", { name: "Revoke patrol approval", exact: true })
      .click();
    await page
      .getByLabel("Reason for revoking patrol approval")
      .fill("Missed the required orientation.");
    await page
      .getByRole("button", { name: "Revoke and send email", exact: true })
      .click();
    await closeEmailFeedback();
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
    await page.reload();
    const summary = profile.locator(".account-profile-summary");
    await expect(
      summary.getByText("Highest medical certification or licence", {
        exact: true,
      }),
    ).toHaveCount(1);
    await expect(
      summary.getByText("Additional certification answer", { exact: true }),
    ).toHaveCount(0); // Legacy additional answers belong to the submitted application, not editable profile rows.
    await expect(
      summary.getByText("Other training and experience", { exact: true }),
    ).toHaveCount(1);
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
    await patrolApproval
      .getByRole("button", { name: "Cancel", exact: true })
      .click();
    await expect(approvePatrols).toBeFocused();
    await approvePatrols.click();
    await page
      .getByRole("button", { name: "Approve and send email", exact: true })
      .click();
    await closeEmailFeedback();
    await expect(patrolApproval.locator("[data-patrol-status]")).toHaveCount(0);
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
      "SELECT patrol_approved, approved_by, approved_at FROM volunteer_status WHERE user_id='applicant-50'",
    ).first();
    assert.equal(recorded?.patrol_approved, 1);
    assert.equal(recorded?.approved_by, "organizer");
    assert.ok(Number(recorded?.approved_at) > 1);
    const approvedDirectory = await get("/volunteers?q=applicant-50");
    assert.match(
      await approvedDirectory.text(),
      /data-volunteer-profile-link[^>]*><span>applicant-50 d\.</,
    );
    // Approval replaces the registered orientation in the summary.
    await expect(
      patrolApproval.locator("[data-orientation-event]"),
    ).toHaveCount(0);
    assert.deepEqual(
      (
        await DB.prepare(
          "SELECT subject FROM event_notification WHERE user_id='applicant-50'",
        ).all<{ subject: string }>()
      ).results
        .map(({ subject }) => subject)
        .sort(),
      [
        "Your volunteer access changed",
        "Your volunteer access changed",
        "Your volunteer access changed",
        "Your volunteer application is approved",
      ],
    );
    await page.getByRole("link", { name: "Back to applications" }).click();
    await expect(count).toHaveText("52");
    await expectAllCount(53);
    await expect(results.locator("[data-volunteer-row]")).toHaveCount(52);
    // Normal full-page links retain exactly the same list context.
    await page.goto(`${origin}${applicationHref}`);
    await expect(
      page.getByRole("link", { name: "Back to applications" }),
    ).toHaveAttribute("href", listPath);
    const documentsBeforeRevocation = documents.length;
    await page
      .getByRole("button", { name: "Revoke application approval" })
      .click();
    await page
      .getByLabel("Reason for revoking approval")
      .fill("Approved by mistake.");
    await page
      .getByRole("button", { name: "Revoke and send email", exact: true })
      .click();
    await closeEmailFeedback();
    await expect(
      page.getByRole("button", { name: "Approve application", exact: true }),
    ).toBeEnabled();
    assert.match(
      String(
        await DB.prepare(
          "SELECT body FROM event_notification WHERE user_id='applicant-50' AND subject='Your volunteer application approval was revoked'",
        ).first("body"),
      ),
      /Reason: Approved by mistake\./,
    );
    await expect(page).toHaveURL(`${origin}${applicationHref}`);
    assert.equal(documents.length, documentsBeforeRevocation);
    await expect(page.locator("[data-application-approved-by]")).toHaveCount(0);
    await page.getByRole("link", { name: "Back to applications" }).click();
    await page.waitForLoadState("load");
    await expect(count).toHaveText("53");
    await expect(results.locator("[data-volunteer-row]")).toHaveCount(53);
    const search = page.locator("[data-volunteer-search]");
    await search.fill("applicant-52");
    await expect(results.locator("[data-volunteer-row]")).toHaveCount(1);
    await expect(count).toHaveText("1");
    await expectAllCount(1);
    expect(new URL(page.url()).searchParams.get("approval")).toBe("awaiting");
    expect(new URL(page.url()).searchParams.has("offset")).toBe(false);
    await search.fill("approved");
    await expect(results.locator("[data-volunteer-row]")).toHaveCount(0);
    await expect(count).toHaveText("0");
    await expectAllCount(1);
    await chooseStatuses([]);
    await expect(results.locator("[data-volunteer-row]")).toHaveCount(1);
    await expect(count).toHaveText("0");
    await expectAllCount(1);
    await expect(
      results.getByRole("link", { name: "approved", exact: true }),
    ).toBeVisible();
    await expect(results.locator('[data-state="approved"]')).toHaveText(
      "Approved",
    );
    await expect(page).toHaveURL(`${origin}/applications?q=approved`);
    await page.goBack();
    await expect(readyInput).toBeChecked();
    await expect(results.locator("[data-volunteer-row]")).toHaveCount(0);
    await expect(search).toHaveValue("approved");
    await search.fill("no match");
    await expect(
      results.getByText("No applications ready for review match your search."),
    ).toBeVisible();
    await expect(count).toHaveText("0");
    await expectAllCount(0);
    await search.fill("applicant");
    await expect(results.locator("[data-volunteer-row]")).toHaveCount(53);
    await expect(
      page.getByRole("link", { name: /^(Next|Previous) applications$/ }),
    ).toHaveCount(0);
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
    await plain.locator("[data-volunteer-search]").press("Enter");
    await expect(
      plain.locator("[data-volunteer-results] [data-volunteer-row]"),
    ).toHaveCount(1);
    expect(new URL(plain.url()).searchParams.get("approval")).toBe("awaiting");
    expect(new URL(plain.url()).searchParams.get("sort")).toBe("progress");
    expect(new URL(plain.url()).searchParams.get("direction")).toBe("desc");
    expect(new URL(plain.url()).searchParams.has("offset")).toBe(false);
    // Without scripts the menu is a native popover in a GET form.
    const plainStatus = plain.locator('[data-filter-menu="approval"]');
    await plain.getByRole("button", { name: /^Status/ }).click();
    await plainStatus.locator('input[value="awaiting"]').uncheck();
    await plainStatus.getByRole("button", { name: "Apply" }).click();
    expect(new URL(plain.url()).searchParams.get("q")).toBe("applicant-52");
    expect(new URL(plain.url()).searchParams.has("approval")).toBe(false);
    await plain.getByRole("button", { name: /^Status/ }).click();
    await plainStatus.locator('input[value="awaiting"]').check();
    await plainStatus.getByRole("button", { name: "Apply" }).click();
    expect(new URL(plain.url()).searchParams.get("approval")).toBe("awaiting");
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
    await sortDirectory(plain, "name", "desc");
    await expect(
      plain.locator("[data-volunteer-results] [data-volunteer-row]"),
    ).toHaveCount(1);
    expect(new URL(plain.url()).searchParams.has("offset")).toBe(false);
    await plain.locator("[data-volunteer-search]").fill("organizer");
    await plain.locator("[data-volunteer-search]").press("Enter");
    expect(new URL(plain.url()).searchParams.get("sort")).toBe("name");
    expect(new URL(plain.url()).searchParams.get("direction")).toBe("desc");
    await expect(plain.locator("[data-volunteer-profile-link]")).toHaveText(
      "organizer",
    );
    // Returning through bfcache must refresh approval changes without losing the
    // restored search or filter.
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
    await expect(headerCount).toHaveText([
      "50 ready for review",
      "50 ready for review",
    ]);
    await expectAllCount(53);
    await expect(results.locator("[data-volunteer-row]")).toHaveCount(50);
    expect(page.url()).toBe(restoredListUrl);
    expect(new URL(page.url()).searchParams.get("approval")).toBe("awaiting");
    await DB.prepare(
      "UPDATE volunteer_status SET registration_approved=1",
    ).run();
    await page.goto(`${origin}/applications?approval=awaiting`);
    await expect(count).toHaveText("0");
    await expectAllCount(55);
    await expect(headerCount).toHaveCount(0);
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

    await page.goto(`${origin}/applications/applicant-50`);
    await page
      .getByRole("button", { name: "Reject application", exact: true })
      .click();
    await page
      .getByLabel("Reason for rejection")
      .fill(`  ${rejection.reason}  `);
    await page
      .getByRole("button", {
        name: "Reject and send email",
        exact: true,
      })
      .click();
    await expect(page.locator("[data-application-rejection]")).toHaveText(
      `Reason: ${rejection.reason}`,
    );
    await expect(headerCount).toHaveCount(0);
    await expect(
      page.locator('[data-application-mini-step="review"]'),
    ).toHaveCount(0);
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
    await expect(headerCount).toHaveCount(0);
    await page.getByRole("link", { name: "Clear filters" }).click();
    await expect(results).toContainText("Rejected");
    assert.notEqual(
      await (await get("/api/v1/events/version", applicantCookie)).text(),
      beforeDecisionVersion,
    );
    for (const path of ["/volunteer", "/volunteer/account"]) {
      const decision = await get(path, applicantCookie);
      assert.equal(decision.status, 200);
      const decisionHtml = await decision.text();
      assert.match(
        decisionHtml,
        path === "/volunteer/account"
          ? /data-application-mini-step="review" data-state="rejected"/
          : /Application rejected/,
      );
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
