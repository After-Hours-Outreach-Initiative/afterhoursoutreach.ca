import { expect, test, type Locator } from "@playwright/test";
import {
  createLocalAccount,
  openLocalAccountSwitcher,
} from "../helpers/local-account";

async function expectReadableCards(progression: Locator) {
  const cards = progression.locator("[data-progression-stage]");
  await expect(cards).toHaveCount(2);
  await expect(
    cards.nth(0).getByRole("heading", { name: "New volunteer", exact: true }),
  ).toBeVisible();
  await expect(
    cards
      .nth(1)
      .getByRole("heading", { name: "Outreach Volunteer", exact: true }),
  ).toBeVisible();
  await expect(progression.getByText(/^(Current|Upcoming)$/)).toHaveCount(0);
  await expect(
    progression.locator("[data-application-progress-mini]"),
  ).toHaveCount(0);
  await expect(cards.locator('[data-access-kind="application"]')).toHaveCount(
    0,
  );
  await expect(cards.locator(".progression-heading").first()).toHaveCSS(
    "display",
    "flex",
  );
  const layout = await cards.evaluateAll((elements) =>
    elements.map((card) => {
      const bounds = card.getBoundingClientRect();
      const paragraph = card.querySelector(".progression-description")!;
      const description = paragraph.getBoundingClientRect();
      const marker = card
        .querySelector(".progression-marker")!
        .getBoundingClientRect();
      const heading = card.querySelector("h3")!.getBoundingClientRect();
      return {
        state: card.getAttribute("data-state"),
        display: getComputedStyle(card).display,
        background: getComputedStyle(card).backgroundColor,
        top: bounds.top,
        bottom: bounds.bottom,
        width: bounds.width,
        descriptionWidth: description.width,
        descriptionLines:
          description.height /
          parseFloat(getComputedStyle(paragraph).lineHeight),
        markerCenter: marker.top + marker.height / 2,
        headingCenter: heading.top + heading.height / 2,
        headingGap: heading.left - marker.right,
        overflowing: card.scrollWidth > card.clientWidth,
      };
    }),
  );
  for (const [index, card] of layout.entries()) {
    expect(card.display).toBe("block");
    expect(card.descriptionWidth).toBeGreaterThan(card.width - 40);
    expect(card.descriptionLines).toBeLessThanOrEqual(4);
    expect(Math.abs(card.markerCenter - card.headingCenter)).toBeLessThan(1);
    expect(card.headingGap).toBeGreaterThanOrEqual(12);
    expect(card.overflowing).toBe(false);
    expect(card.background).toBe(
      card.state === "current"
        ? "rgb(20, 36, 59)"
        : card.state === "complete"
          ? "rgb(16, 26, 20)"
          : "rgb(17, 19, 24)",
    );
    if (index > 0)
      expect(card.top - layout[index - 1].bottom).toBeGreaterThanOrEqual(12);
  }
}

test("roster links open profile pages with readable progression cards", async ({
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
    const progression = page.locator("[data-volunteer-progression]");
    await expect(progression).toBeVisible();
    await expectReadableCards(progression);
    await expect(progression.locator("[data-orientation-status]")).toHaveText(
      "Orientation not completed",
    );
    await expect(
      progression.getByRole("button", {
        name: "Approve for patrols",
        exact: true,
      }),
    ).toBeEnabled();
    await progression.screenshot({
      path: testInfo.outputPath(`progression-roster-profile-${width}.png`),
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
      const progression = page.locator("[data-volunteer-progression]");
      await expectReadableCards(progression);
      const application = page.locator(
        '[data-volunteer-profile-panel="application"]',
      );
      await expect(
        application.locator(".application-progress-mini-title"),
      ).toHaveText(["Application form", "Naloxone 101", "Application review"]);
      await expect(progression.locator('[aria-current="step"]')).toHaveCount(0);
      await expect(
        progression.getByText("Ready for review", { exact: true }),
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
      await progression.screenshot({
        path: testInfo.outputPath(`progression-applicant-${width}.png`),
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
