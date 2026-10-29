import { expect, test, type Locator } from "@playwright/test";
import { social } from "../../src/data/site";
import {
  approveLocalApplication,
  createLocalAccount,
  openLocalAccountSwitcher,
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
    await expect(formStep.locator(":scope > summary")).toContainText(
      "Application Form Submitted",
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
      page.getByRole("link", { name: "Manage events", exact: true }),
    ).toBeVisible();
    await page.goto(`/manage/volunteers/${account.id}`);
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
    await volunteer
      .getByRole("button", { name: /^Orientations \(\d+\)$/ })
      .click();
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
      page.getByRole("link", { name: "Manage events", exact: true }),
    ).toBeVisible();
    const profile = await page.request.get(`/manage/volunteers/${account.id}`);
    const profileHtml = await profile.text();
    expect(profileHtml).toContain("Application in progress");
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
      await (await page.request.get(`/manage/volunteers/${account.id}`)).text(),
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
    await expect(
      completedInfo.locator("[data-submitted-application]"),
    ).toBeVisible();
    await expect(completedInfo).toContainText("Naloxone 101 completion");
    await expect(completedInfo).toContainText("Application approved");
  } finally {
    await volunteerContext.close();
  }
});
