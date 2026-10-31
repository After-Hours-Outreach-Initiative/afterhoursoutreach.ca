import { expect, test, type Locator } from "@playwright/test";
import {
  createLocalAccount,
  openLocalAccountSwitcher,
} from "../helpers/local-account";

async function expectReadableCard(card: Locator) {
  await expect(card).toHaveCount(1);
  await expect(
    card.getByRole("heading", { name: "Patrol Approval", exact: true }),
  ).toBeVisible();
  await expect(card.getByRole("list")).toHaveCount(0);
  await expect(card.locator("[data-application-progress-mini]")).toHaveCount(0);
  await expect(card.locator('[data-access-kind="application"]')).toHaveCount(0);
  await expect(card).toHaveCSS("background-color", "rgb(17, 19, 24)");
  expect(
    await card.evaluate((element) => element.scrollWidth > element.clientWidth),
  ).toBe(false);
}

test("roster links open profile pages with one readable patrol approval card", async ({
  page,
  browser,
  baseURL,
}, testInfo) => {
  test.skip(!baseURL?.startsWith("http://localhost:"));
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/volunteer");
  await (
    await openLocalAccountSwitcher(page)
  )
    .locator('[data-switch-user="local-fixture-user-robin"]')
    .click();
  await expect(page.locator("[data-event-list]")).toBeVisible();

  for (const width of [320, 390, 1280]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto("/events");
    await expect(page.locator(".attendee-new-volunteer").first()).toHaveCSS(
      "color",
      "rgb(65, 105, 225)",
    );
    const roster = page.locator(
      '[data-live-event="local-fixture-event-orientation"] .volunteer-roster',
    );
    await roster.locator("summary").click();
    const profileLink = roster.locator("[data-volunteer-profile-link]").first();
    const profileUrl = new URL(
      (await profileLink.getAttribute("href"))!,
      page.url(),
    ).href;
    await profileLink.click();
    await expect(page).toHaveURL(profileUrl);
    await expect(
      page.getByRole("dialog", { name: "Volunteer profile", exact: true }),
    ).toHaveCount(0);
    const patrolApproval = page.getByRole("region", {
      name: "Patrol Approval",
      exact: true,
    });
    await expect(patrolApproval).toBeVisible();
    await expectReadableCard(patrolApproval);
    await expect(
      patrolApproval.locator("[data-orientation-status]"),
    ).toHaveText("Orientation not completed");
    await expect(
      patrolApproval.getByRole("button", {
        name: "Approve for patrols",
        exact: true,
      }),
    ).toBeEnabled();
    await expect(
      page.locator('.volunteer-profile-controls [data-access-kind="patrol"]'),
    ).toHaveCount(0);
    await patrolApproval.screenshot({
      path: testInfo.outputPath(`patrol-approval-roster-profile-${width}.png`),
    });
    await page.goBack();
    await expect(page).toHaveURL(/\/events$/);
  }

  const applicantContext = await browser.newContext();
  try {
    const applicant = await createLocalAccount(
      applicantContext.request,
      baseURL!,
    );
    for (const width of [320, 390, 1280]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.goto(`/volunteers/${applicant.id}`);
      const patrolApproval = page.getByRole("region", {
        name: "Patrol Approval",
        exact: true,
      });
      await expectReadableCard(patrolApproval);
      const application = page.locator(
        '[data-volunteer-profile-panel="application"]',
      );
      await expect(
        application.locator(".application-progress-mini-title"),
      ).toHaveText(["Application form", "Naloxone 101", "Application review"]);
      await expect(patrolApproval.getByRole("button")).toHaveCount(0);
      await expect(
        patrolApproval.getByText("Ready for review", { exact: true }),
      ).toHaveCount(0);
      await expect(
        application.getByRole("button", {
          name: "Approve application",
          exact: true,
        }),
      ).toBeEnabled();
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth),
      ).toBe(width);
      await patrolApproval.screenshot({
        path: testInfo.outputPath(`patrol-approval-applicant-${width}.png`),
      });
      await application
        .getByText("Reject application", { exact: true })
        .click();
      const reason = application.getByRole("textbox", {
        name: "Reason for rejection",
      });
      await expect(reason).toBeVisible();
      const card = application.locator('[data-application-mini-step="review"]');
      const cardBounds = (await card.boundingBox())!;
      const reasonBounds = (await reason.boundingBox())!;
      expect(reasonBounds.x + reasonBounds.width).toBeLessThanOrEqual(
        cardBounds.x + cardBounds.width,
      );
    }
  } finally {
    await applicantContext.close();
  }
});
