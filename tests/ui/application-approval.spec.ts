import { expect, test, type Locator } from "@playwright/test";
import { social } from "../../src/data/site";
import {
  approveLocalApplication,
  createLocalAccount,
  openLocalAccountSwitcher,
  signInLocalAuthenticatorAccount,
} from "../helpers/local-account";

async function expectCompletedStep(step: Locator) {
  await expect(step).toHaveAttribute("data-state", "complete");
  const summary = step.locator(":scope > summary");
  const marker = summary.locator(".application-progress-marker");
  await expect(marker).toHaveText("");
  await expect(marker).toHaveCSS("border-radius", "50%");
  await expect(marker).toHaveCSS("border-top-width", "1px");
  await expect(marker).toHaveCSS("border-top-style", "solid");
  await expect(marker.locator("svg")).toHaveAttribute("aria-hidden", "true");
  await expect(marker.locator("path")).toHaveAttribute("d", "m5 12 4 4L19 6");
  await expect(
    summary.locator(
      ".application-progress-number, .application-progress-title svg",
    ),
  ).toHaveCount(0);
  const status = summary.locator(".application-progress-status");
  await expect(status).toHaveText(
    /^Completed: (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{1,2}, \d{4}$/,
  );
  await expect(status.locator("time")).toHaveAttribute("datetime", /T.*Z$/);
  await expect(status).toHaveCSS("font-size", "14px");
  await expect(summary.locator(".application-progress-title")).toHaveCSS(
    "font-size",
    "18px",
  );
}

test("application table opens a focused review with guarded decisions and list context", async ({
  page,
  browser,
  baseURL,
}) => {
  test.skip(!baseURL?.startsWith("http://localhost:"));
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.setViewportSize({ width: 375, height: 812 });
  const applicantContext = await browser.newContext();
  try {
    const account = await createLocalAccount(
      applicantContext.request,
      baseURL!,
    );
    const applicationPath = `/applications/${account.id}`;
    await signInLocalAuthenticatorAccount(page.request, baseURL!);
    const listPath = `/applications?${new URLSearchParams({
      q: account.name,
      sort: "completed",
      direction: "desc",
    })}`;
    await page.goto(listPath);
    const row = page.locator("[data-volunteer-row]").filter({
      has: page.locator(`a[href^="${applicationPath}?"]`),
    });
    await expect(row.locator("[data-volunteer-profile-link]")).toHaveAttribute(
      "href",
      `${applicationPath}?returnTo=${encodeURIComponent(listPath)}`,
    );
    const filters = page.getByRole("group", { name: "Application status" });
    await expect(filters.getByRole("button")).toHaveText([
      "All 1",
      "Ready for review 0",
      "In Progress 1",
      "Rejected 0",
      "Approved 0",
    ]);
    for (const value of ["awaiting", "rejected", "approved"]) {
      const filter = filters.locator(`[data-volunteer-filter="${value}"]`);
      await filter.click();
      await expect(filter).toHaveAttribute("aria-pressed", "true");
      await expect(row).toHaveCount(0);
      expect(new URL(page.url()).searchParams.get("approval")).toBe(value);
      expect(new URL(page.url()).searchParams.get("sort")).toBe("completed");
      expect(new URL(page.url()).searchParams.get("direction")).toBe("desc");
    }
    const inProgress = filters.getByRole("button", {
      name: "In Progress 1",
      exact: true,
    });
    await inProgress.focus();
    await page.keyboard.press("Enter");
    await expect(inProgress).toHaveAttribute("aria-pressed", "true");
    await expect(inProgress).toBeFocused();
    await expect(inProgress).toHaveCSS("outline-style", "solid");
    for (const property of [
      "color",
      "font-size",
      "font-weight",
      "font-family",
      "background-color",
      "border-radius",
      "padding",
      "display",
      "line-height",
    ]) {
      const tableStyle = await row
        .locator(".application-status-text")
        .evaluate(
          (element, property) =>
            getComputedStyle(element).getPropertyValue(property),
          property,
        );
      await expect(inProgress.locator(".application-status-text")).toHaveCSS(
        property,
        tableStyle,
      );
    }
    expect(new URL(page.url()).searchParams.get("approval")).toBe(
      "in-progress",
    );
    await filters.getByRole("button", { name: "All 1", exact: true }).click();
    await expect(page).toHaveURL(new URL(listPath, baseURL!).href);
    await row.click({ position: { x: 2, y: 2 } });
    const review = page.locator("[data-application-review]");
    await expect(review.getByRole("heading", { level: 1 })).toContainText(
      account.name,
    );
    await expect(
      review.getByRole("heading", { name: "Application Steps", exact: true }),
    ).toBeVisible();
    await expect(review.locator("[data-patrol-approval]")).toHaveCount(0);
    const approve = review.getByRole("button", {
      name: "Approve application",
      exact: true,
    });
    const reject = review.getByRole("button", {
      name: "Reject application",
      exact: true,
    });
    for (const button of [approve, reject]) {
      await expect(button).toBeDisabled();
      await expect(button).toHaveCSS("background-color", "rgb(39, 39, 42)");
      await expect
        .poll(() =>
          button.evaluate((button) =>
            Math.abs(
              button.getBoundingClientRect().width -
                button
                  .closest(".application-decision-actions")!
                  .getBoundingClientRect().width,
            ),
          ),
        )
        .toBeLessThan(1);
    }
    const steps = review.locator("[data-application-mini-step]");
    await expect(steps).toHaveCount(2);
    await expect(
      review.locator('[data-application-mini-step="review"]'),
    ).toHaveCount(0);
    await expect(steps.locator("time")).toHaveCount(1);
    await expect(steps.locator("time")).toHaveText(/\d{1,2}:\d{2}/);
    const completion = await applicantContext.request.post(
      "/api/v1/account/naloxone",
      {
        headers: { origin: baseURL! },
        data: { userId: account.id, completed: true },
      },
    );
    expect(completion.status()).toBe(200);
    await page.reload();
    await expect(approve).toBeEnabled();
    await expect(steps.locator("time")).toHaveCount(2);
    const rejectAction = review.locator("[data-rejection-open]");
    await expect(rejectAction).toHaveClass(/\bbtn btn-red\b/);
    for (const button of [approve, review.locator(".rejection-surface")]) {
      await expect
        .poll(() =>
          button.evaluate((button) =>
            Math.abs(
              button.getBoundingClientRect().width -
                button
                  .closest(".application-decision-actions")!
                  .getBoundingClientRect().width,
            ),
          ),
        )
        .toBeLessThan(1);
    }
    const morph = await rejectAction.evaluate((trigger) => {
      (trigger as HTMLButtonElement).click();
      return (
        trigger.parentElement!.getAnimations()[0].effect as KeyframeEffect
      ).getKeyframes();
    });
    expect(Number.parseFloat(String(morph[1].height))).toBeGreaterThan(
      Number.parseFloat(String(morph[0].height)),
    );
    expect(morph[0].backgroundColor).toBe(morph[1].backgroundColor);
    const rejection = review.locator("application-rejection");
    const rejectionForm = rejection.getByRole("form", {
      name: "Reject application",
      exact: true,
    });
    await expect(
      rejectionForm.getByRole("heading", {
        name: "Reject application",
        level: 3,
        exact: true,
      }),
    ).toBeVisible();
    const reason = review.getByRole("textbox", {
      name: "Reason for rejection",
    });
    await expect(reason).toBeEnabled();
    await expect(rejectionForm).toBeFocused();
    await expect(reason).not.toBeFocused();
    await expect(rejectAction).toHaveAttribute("aria-expanded", "true");
    await expect(rejectAction).toBeHidden();
    await expect(rejection.locator(".rejection-surface")).toHaveCSS(
      "background-color",
      "rgb(0, 0, 0)",
    );
    await expect(rejection.locator(".rejection-actions button")).toHaveText([
      "Cancel",
      "Reject and send email",
    ]);
    await expect(rejection.locator(".rejection-actions")).toHaveCSS(
      "justify-content",
      "flex-end",
    );
    for (const width of [1280, 375]) {
      await page.setViewportSize({ width, height: 812 });
      const rejectionBounds = (await rejection.boundingBox())!;
      if (width === 1280) expect(rejectionBounds.width).toBeGreaterThan(576);
      const surface = rejection.locator(".rejection-surface");
      await expect
        .poll(async () =>
          Math.abs(
            (await surface.boundingBox())!.width -
              Math.min(rejectionBounds.width, 576),
          ),
        )
        .toBeLessThan(1);
      expect((await surface.boundingBox())!.x).toBeCloseTo(rejectionBounds.x);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth),
      ).toBe(width);
    }
    await reason.fill("A draft reason");
    await review.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(rejectAction).toHaveAttribute("aria-expanded", "false");
    await expect(rejectAction).toBeFocused();
    await expect(reason).toBeHidden();
    await rejectAction.press("Enter");
    await expect(rejectionForm).toBeFocused();
    await expect(reason).toHaveValue("A draft reason");
    await reason.press("Escape");
    await expect(rejectAction).toBeFocused();
    for (const time of await steps.locator("time").all()) {
      await expect(time).toHaveText(/\d{1,2}:\d{2}/);
      await expect(time).toHaveAttribute("datetime", /T.*Z$/);
    }
    const back = page.getByRole("link", {
      name: "Back to applications",
      exact: true,
    });
    await expect(back).toHaveAttribute("href", listPath);
  } finally {
    await applicantContext.close();
  }
});

test("pending applications poll every minute, then approval restores five-second event checks", async ({
  page,
  browser,
  baseURL,
}) => {
  test.skip(
    !baseURL?.startsWith("http://localhost:"),
    "Local D1 development only",
  );
  const volunteerContext = await browser.newContext();
  try {
    const volunteer = await volunteerContext.newPage();
    const account = await createLocalAccount(volunteer.request, baseURL!);
    await volunteer.goto(`${baseURL}/volunteer`);
    await expect(
      volunteer.getByRole("heading", { name: "Welcome", exact: true }),
    ).toBeVisible();
    await expect(volunteer.locator('header a[href="/volunteer"]')).toHaveText([
      "Volunteer",
      "Volunteer",
    ]);
    await expect(
      volunteer.locator('[data-application-progress-step="form"] > summary'),
    ).toBeVisible();
    await expect(
      volunteer.locator(
        "[data-live-event], [data-event-list], [data-event-save], [data-event-notifications]",
      ),
    ).toHaveCount(0);
    const portal = volunteer.locator("[data-event-browser]");
    const tracker = portal.locator("[data-application-tracker]");
    const formStep = tracker.locator('[data-application-progress-step="form"]');
    const naloxone = tracker.locator(
      '[data-application-progress-step="naloxone"]',
    );
    const review = tracker.locator('[data-application-progress-step="review"]');
    await expect(
      tracker.locator("[data-application-progress-step]"),
    ).toHaveCount(3);
    await expect(
      tracker.locator('[data-application-progress-step="orientation"]'),
    ).toHaveCount(0);
    await expect(portal).toHaveAttribute(
      "data-application-awaiting-approval",
      "true",
    );
    await expectCompletedStep(formStep);
    await expect(tracker).not.toContainText(/Current step|Not started/);
    await expect(naloxone.locator(".application-progress-number")).toHaveText(
      "2",
    );
    await expect(review.locator(".application-progress-number")).toHaveText(
      "3",
    );
    for (const title of await tracker
      .locator(".application-progress-title")
      .all()) {
      await expect(title).toHaveCSS("font-size", "18px");
    }
    const courseLink = naloxone.getByRole("link", {
      name: "Take Naloxone 101",
    });
    await expect(courseLink).toHaveAttribute("target", "_blank");
    await expect(courseLink.locator("svg")).toHaveAttribute(
      "aria-hidden",
      "true",
    );
    await expect(courseLink.locator("path")).toHaveAttribute(
      "d",
      "M7 17 17 7M7 7h10v10",
    );
    await expect(naloxone.locator(".application-progress-status")).toHaveCount(
      0,
    );
    await expect(review.locator(".application-progress-status")).toHaveCount(0);
    for (const paragraph of await tracker.locator("p").all()) {
      await expect(paragraph).toHaveCSS("font-size", "16px");
    }
    for (const toggle of await tracker
      .locator(".application-progress-toggle")
      .all()) {
      await expect(toggle.locator("path")).toHaveAttribute("d", "m6 9 6 6 6-6");
    }
    const formToggle = formStep.locator(".application-progress-toggle");
    await expect(formToggle).toHaveCSS("transform", "none");
    await expect(formStep).not.toHaveAttribute("open");
    await expect(formStep.locator(".application-progress-title")).toHaveText(
      "Step 1: Application Form",
    );
    await expect(formStep.locator("summary svg").first()).toHaveAttribute(
      "aria-hidden",
      "true",
    );
    await expect(review.locator("p")).toHaveText(
      "An organizer will review your application. We’ll email you to let you know whether it’s approved and what to do next. You can also return to this page to check its status.",
    );
    await formStep.locator(":scope > summary").click();
    await expect(formToggle).toHaveCSS(
      "transform",
      "matrix(-1, 0, 0, -1, 0, 0)",
    );
    await expect(
      formStep.locator("[data-submitted-application] summary"),
    ).toHaveText("View submitted application");
    const submittedApplication = formStep.locator(
      "[data-submitted-application]",
    );
    await submittedApplication.locator("summary").click();
    await volunteer.locator("[data-naloxone-confirm] input").check();
    await volunteer
      .getByRole("button", { name: "Confirm completion", exact: true })
      .click();
    await expect(review).toHaveAttribute("open");
    await expect(review.locator(".application-progress-status")).toHaveText(
      "Ready for review",
    );
    await expectCompletedStep(naloxone);
    await expect(formStep).toHaveAttribute("open");
    await expect(submittedApplication.locator("details")).toHaveAttribute(
      "open",
    );
    await expect(naloxone.locator('[name="completed"]')).toBeChecked();
    await expect(naloxone.locator('[name="completed"]')).toBeDisabled();
    await expect(
      portal.getByText("Join our Discord for the most up-to-date information."),
    ).toBeVisible();
    const discord = portal.getByRole("link", { name: "Join Discord" });
    await expect(discord).toBeVisible();
    await expect(discord).toHaveAttribute("href", social.discord);
    expect(
      (await volunteer.request.get(`${baseURL}/api/v1/events`)).status(),
    ).toBe(403);
    await volunteer.goto(`${baseURL}/volunteer/account`);
    await expect(volunteer.locator('header a[href="/volunteer"]')).toHaveCount(
      2,
    );
    await expect(
      volunteer
        .getByRole("status")
        .filter({ hasText: "awaiting organizer approval" }),
    ).toHaveCount(0);
    await volunteer.clock.install();
    await volunteer.clock.pauseAt(new Date());
    let checks = 0;
    volunteer.on("requestfinished", (request) => {
      if (request.url().endsWith("/api/v1/events/version")) checks++;
    });
    await volunteer.goto(`${baseURL}/volunteer?type=orientation`);
    await expect.poll(() => checks).toBe(1);
    const documents: string[] = [];
    volunteer.on("request", (request) => {
      if (request.resourceType() === "document") documents.push(request.url());
    });

    await page.goto("/volunteer");
    await (
      await openLocalAccountSwitcher(page)
    )
      .locator('[data-switch-user="local-fixture-user-robin"]')
      .click();
    await expect(
      page.getByRole("button", { name: "Create", exact: true }),
    ).toBeVisible();
    await page.goto(`/volunteers/${account.id}`);
    await page
      .getByRole("link", { name: "View application", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Approve application", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Save without email", exact: true })
      .click();
    await expect(
      page.getByRole("button", {
        name: "Revoke application approval",
        exact: true,
      }),
    ).toBeEnabled();
    const approval = page.locator("[data-application-approved-by]");
    await expect(approval.locator("dd")).toHaveText("Robin V.");
    await expect(
      approval.locator("[data-volunteer-profile-link]"),
    ).toHaveAttribute("href", "/volunteers/local-fixture-user-robin");
    await expect(
      page.getByRole("link", { name: "View volunteer profile", exact: true }),
    ).toHaveAttribute("href", `/volunteers/${account.id}`);
    const accountPage = await volunteerContext.newPage();
    await accountPage.goto(`${baseURL}/volunteer/account`);
    await accountPage
      .getByRole("link", { name: "View your profile", exact: true })
      .click();
    await expect(accountPage).toHaveURL(/#account-profile-heading$/);
    await accountPage.close();
    expect(
      (await page.request.get("/volunteers/local-fixture-user-robin")).status(),
    ).toBe(200);
    await volunteer.clock.runFor(59_999);
    expect(checks).toBe(1);
    await expect(portal).toHaveAttribute(
      "data-application-awaiting-approval",
      "true",
    );
    await volunteer.clock.runFor(1);
    await expect.poll(() => checks).toBe(2);
    // Approval refreshes the portal in place; it retains the current route.
    await expect(volunteer).toHaveURL(/\/volunteer\?type=orientation$/);
    await expect(volunteer.locator('header a[href="/events"]')).toHaveText([
      "Events",
      "Events",
    ]);
    await expect(volunteer.locator("[data-portal-heading]")).toHaveText(
      "Events",
    );
    await expect(volunteer.locator("[data-event-list]")).toBeVisible({
      timeout: 15_000,
    });
    await expect(portal).toHaveAttribute(
      "data-application-awaiting-approval",
      "false",
    );
    await expect(tracker).toHaveCount(0);
    await expect(
      portal.locator(
        '.application-progress, #events-application-heading, [href="#events-application-heading"]',
      ),
    ).toHaveCount(0);
    await expect(
      volunteer.locator('[data-live-event][data-includes-orientation="false"]'),
    ).toHaveCount(0);
    await expect(discord).toHaveCount(0);
    await volunteer.clock.runFor(4_999);
    expect(checks).toBe(2);
    await volunteer.clock.runFor(1);
    await expect.poll(() => checks).toBe(3);
    await expect(volunteer).toHaveURL(/\?type=orientation$/);
    const orientation = volunteer
      .locator('[data-live-event][data-includes-orientation="true"]')
      .filter({ hasText: "Strathcona Community Centre" });
    await orientation
      .getByRole("button", { name: "Register", exact: true })
      .click();
    await expect(
      orientation.getByRole("button", { name: "Unregister", exact: true }),
    ).toBeVisible();
    await expect(tracker).toHaveCount(0);
    await orientation
      .getByRole("button", { name: "Unregister", exact: true })
      .click();
    await volunteer
      .getByRole("dialog", { name: "Unregister from this event?", exact: true })
      .getByRole("button", { name: "Unregister", exact: true })
      .click();
    await expect(tracker).toHaveCount(0);
    expect(
      (await volunteer.request.get(`${baseURL}/api/v1/events`)).status(),
    ).toBe(200);

    await page
      .getByRole("button", {
        name: "Revoke application approval",
        exact: true,
      })
      .click();
    await page
      .getByRole("button", { name: "Save without email", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Approve application", exact: true }),
    ).toBeEnabled();
    await volunteer.clock.runFor(5_000);
    await expect(portal).toHaveAttribute(
      "data-application-awaiting-approval",
      "true",
      { timeout: 15_000 },
    );
    await expect(review).toHaveAttribute("data-state", "current");
    await expect(review).toHaveAttribute("open");
    await expect(volunteer).toHaveURL(/\/volunteer\?type=orientation$/);
    await expect(volunteer.locator('header a[href="/volunteer"]')).toHaveText([
      "Volunteer",
      "Volunteer",
    ]);
    await expect(
      volunteer.getByRole("heading", { name: "Welcome", exact: true }),
    ).toBeVisible();
    expect(documents).toEqual([]);
    await expect(
      volunteer.locator("[data-live-event], [data-event-list]"),
    ).toHaveCount(0);
    await expect(discord).toBeVisible();
    const revokedChecks = checks;
    await volunteer.clock.runFor(59_999);
    expect(checks).toBe(revokedChecks);
    await volunteer.clock.runFor(1);
    await expect.poll(() => checks).toBe(revokedChecks + 1);
    expect(
      (await volunteer.request.get(`${baseURL}/api/v1/events`)).status(),
    ).toBe(403);
  } finally {
    await volunteerContext.close();
  }
});

test("an in-progress application preserves its course draft and focus until confirmation makes it ready for review", async ({
  page,
  browser,
  baseURL,
}) => {
  test.skip(
    !baseURL?.startsWith("http://localhost:"),
    "Local D1 development only",
  );
  const volunteerContext = await browser.newContext();
  try {
    const volunteer = await volunteerContext.newPage();
    const account = await createLocalAccount(volunteer.request, baseURL!);
    await volunteer.clock.install();
    await volunteer.clock.pauseAt(new Date());
    let checks = 0;
    volunteer.on("requestfinished", (request) => {
      if (request.url().endsWith("/api/v1/events/version")) checks++;
    });
    await volunteer.goto(`${baseURL}/events`);
    await expect.poll(() => checks).toBe(1);
    await expect(volunteer).toHaveURL(/\/volunteer$/);
    await expect(volunteer.locator('header a[href="/volunteer"]')).toHaveText([
      "Volunteer",
      "Volunteer",
    ]);
    await expect(
      volunteer.getByRole("heading", { name: "Welcome", exact: true }),
    ).toBeVisible();
    const tracker = volunteer.locator("[data-application-tracker]");
    await expect(tracker).toBeVisible();
    const formStep = tracker.locator('[data-application-progress-step="form"]');
    const naloxone = tracker.locator(
      '[data-application-progress-step="naloxone"]',
    );
    const submittedApplication = formStep.locator(
      "[data-submitted-application]",
    );
    await formStep.locator(":scope > summary").click();
    await submittedApplication.locator("summary").click();
    const checkbox = naloxone.locator('[name="completed"]');
    await checkbox.check();
    await checkbox.focus();

    await page.goto("/volunteer");
    await (
      await openLocalAccountSwitcher(page)
    )
      .locator('[data-switch-user="local-fixture-user-robin"]')
      .click();
    await expect(
      page.getByRole("button", { name: "Create", exact: true }),
    ).toBeVisible();
    const profile = await page.request.get(`/applications/${account.id}`);
    const profileHtml = await profile.text();
    expect(profileHtml).toContain(
      'data-application-mini-step="naloxone" data-state="current"',
    );
    const blockedApproval = await page.request.post(
      "/api/v1/organizer/action",
      {
        headers: { origin: baseURL! },
        data: {
          action: "status",
          userId: account.id,
          version: Number(
            profileHtml.match(/name="version" value="(\d+)"/)?.[1],
          ),
          active: true,
          applicationApproved: true,
          patrolApproved: false,
        },
      },
    );
    expect(blockedApproval.status()).toBe(409);
    expect(await blockedApproval.text()).toContain(
      "must complete Naloxone 101",
    );
    await volunteer.clock.runFor(60_000);
    await expect.poll(() => checks).toBe(2);
    const review = tracker.locator('[data-application-progress-step="review"]');
    await expect(review).toHaveAttribute("data-state", "upcoming");
    await expect(
      review.getByText("Ready for review", { exact: true }),
    ).toHaveCount(0);
    await expect(naloxone).toHaveAttribute("data-state", "current");
    const approvedCourseLink = naloxone.getByRole("link", {
      name: "Take Naloxone 101",
    });
    await expect(approvedCourseLink).toHaveCount(1);
    await expect(approvedCourseLink).toBeVisible();
    await expect(approvedCourseLink).toHaveAttribute(
      "href",
      "https://towardtheheart.com/naloxone-course",
    );
    await expect(formStep).toHaveAttribute("open");
    await expect(submittedApplication.locator("details")).toHaveAttribute(
      "open",
    );
    await expect(submittedApplication).toContainText(account.name);
    await expect(checkbox).toBeChecked();
    await expect(checkbox).toBeEnabled();
    await expect(checkbox).toBeFocused();
    await expect(volunteer).toHaveURL(/\/volunteer$/);
    await expect(volunteer.locator("[data-event-list]")).toHaveCount(0);
    const courseSummary = naloxone.locator(":scope > summary");
    await courseSummary.click();
    await courseSummary.focus();
    await volunteer.clock.runFor(60_000);
    await expect.poll(() => checks).toBe(3);
    await expect(naloxone).not.toHaveAttribute("open");
    await expect(courseSummary).toBeFocused();
    await expect(checkbox).toBeChecked();
    await courseSummary.click();
    await tracker
      .getByRole("button", { name: "Confirm completion", exact: true })
      .click();
    await expect(review).toHaveAttribute("data-state", "current");
    await expect(
      review.getByText("Ready for review", { exact: true }),
    ).toBeVisible();
    await expect(naloxone).toHaveAttribute("data-state", "complete");
    await expect(volunteer.locator("[data-event-list]")).toHaveCount(0);
    expect(
      await (await page.request.get(`/volunteers/${account.id}`)).text(),
    ).toContain("Ready for review");
    await approveLocalApplication(page.request, baseURL!, account.id);
    await volunteer.clock.runFor(60_000);
    await expect(tracker).toHaveCount(0);
    await expect(volunteer).toHaveURL(/\/volunteer$/);
    await expect(volunteer.locator('header a[href="/events"]')).toHaveText([
      "Events",
      "Events",
    ]);
    await expect(volunteer.locator("[data-event-list]")).toBeVisible();
    await expect(
      volunteer.locator(
        '.application-progress, #events-application-heading, [href="#events-application-heading"]',
      ),
    ).toHaveCount(0);
    await volunteer.reload();
    await expect(tracker).toHaveCount(0);
    await expect(volunteer.locator("[data-event-list]")).toBeVisible();

    await volunteer.goto(`${baseURL}/volunteer/account`);
    await expect(
      volunteer.locator("#submitted-application-heading"),
    ).toBeVisible();
    const completedInfo = volunteer.locator(
      'section[aria-labelledby="submitted-application-heading"]',
    );
    const completedSteps = completedInfo.locator(
      "[data-application-mini-step]",
    );
    await expect(completedSteps).toHaveCount(3);
    for (const step of await completedSteps.all()) {
      await expect(step).toHaveAttribute("data-state", "complete");
      await expect(
        step.locator(".application-progress-mini-marker svg"),
      ).toHaveAttribute("aria-hidden", "true");
      const time = step.locator(".application-progress-mini-heading time");
      await expect(time).toHaveText(/\d{1,2}:\d{2}/);
      await expect(time).toHaveAttribute("datetime", /T.*Z$/);
    }
    const application = completedInfo.locator(
      '[data-application-mini-step="form"] details',
    );
    await expect(application).not.toHaveAttribute("open");
    await application.locator("summary").click();
    await expect(
      application.getByText(account.email, { exact: true }),
    ).toBeVisible();
    await expect(application.locator("details")).toHaveCount(0);
  } finally {
    await volunteerContext.close();
  }
});
