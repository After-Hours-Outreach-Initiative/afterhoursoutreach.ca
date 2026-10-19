import { expect, test, type Page } from "@playwright/test";
import { motivationMaxWords } from "../../src/data/application";
import {
  createLocalAccount,
  fillApplicationField,
  localApplicationReviewButton,
} from "../helpers/local-account";

test.beforeEach(({ baseURL }) => {
  test.skip(
    !baseURL?.startsWith("http://localhost:"),
    "Requires local development",
  );
});

async function expectComplete(page: Page, section: string, complete: boolean) {
  const links = page.locator(
    `[data-application-progress-link][href="#application-${section}"]`,
  );
  await expect(links).toHaveCount(2);
  for (const link of await links.all()) {
    await expect(link).toHaveAttribute("data-complete", String(complete));
    await expect(link).toHaveAccessibleDescription(
      complete ? "Complete" : "Incomplete",
    );
  }
}

for (const width of [390, 1280]) {
  test(`progress follows valid required answers and conditional fields at ${width}px`, async ({
    page,
    baseURL,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await createLocalAccount(page.request, baseURL!, false);
    await page.goto("/apply");
    const form = page.locator("form[data-application]");
    const count = page.locator("[data-application-progress-count]");
    const tracker = page.getByRole("navigation", {
      name: "Application progress",
    });
    const menu = tracker.locator("[data-contents-menu]");
    const reviewButton = localApplicationReviewButton(page);
    const bottomReview = localApplicationReviewButton(page, "bottom");
    const draftActions = page.locator("[data-application-draft-actions]");
    const discard = draftActions.locator("[data-draft-discard]");
    await expectComplete(page, "overview", true);
    await expectComplete(page, "personal-info", false);
    await expectComplete(page, "emergency-contact", false);
    await expectComplete(page, "team-interests", true);
    await expectComplete(page, "training-and-safety", false);
    await expectComplete(page, "about-volunteering", false);
    await expect(count).toHaveText(["1/5 complete", "1/5 complete"]);
    await expect(form.locator("[data-error]:visible")).toHaveCount(0);
    await expect(page.locator("[data-application-review]")).toHaveCount(3);
    await expect(form.locator("[data-application-review]")).toHaveCount(0);
    await expect(reviewButton).toBeEnabled();
    await expect(bottomReview).toBeVisible();
    await expect(bottomReview).toBeEnabled();
    await expect(bottomReview).toHaveAccessibleName("Review application");
    await expect(
      bottomReview.locator("..").locator("[data-draft-discard]"),
    ).toHaveCount(1);
    const bottomBounds = (await bottomReview.boundingBox())!;
    const discardBounds = (await discard.boundingBox())!;
    expect(bottomBounds.x).toBeGreaterThanOrEqual(0);
    expect(discardBounds.x + discardBounds.width).toBeLessThanOrEqual(width);
    if (width < 1024) {
      const actionsBounds = (await bottomReview.locator("..").boundingBox())!;
      expect(bottomBounds.y + bottomBounds.height).toBeLessThan(
        discardBounds.y,
      );
      for (const bounds of [bottomBounds, discardBounds]) {
        expect(bounds.x).toBe(actionsBounds.x);
        expect(bounds.width).toBe(actionsBounds.width);
      }
    } else {
      expect(bottomBounds.y).toBe(discardBounds.y);
      expect(bottomBounds.x + bottomBounds.width).toBeLessThan(discardBounds.x);
    }
    if (width < 1024) {
      await expect(reviewButton).toBeHidden();
      await expect(
        page.getByRole("button", { name: "Review application", exact: true }),
      ).toHaveCount(1);
    } else {
      await expect(reviewButton).toBeInViewport();
    }
    for (const button of [reviewButton, bottomReview])
      expect(
        await button.evaluate((button: HTMLButtonElement) =>
          button.form?.hasAttribute("data-application"),
        ),
      ).toBe(true);
    const overview = tracker.locator(
      '.volunteer-contents-sidebar [href="#application-overview"]',
    );
    const checkmark = overview.locator("svg");
    await expect(checkmark).toHaveCSS("color", "rgb(74, 222, 128)");
    await expect(checkmark).toHaveCSS("visibility", "visible");
    await expect(checkmark).toHaveCSS("border-width", "0px");
    expect(
      await overview.evaluate((link) =>
        link.lastElementChild?.previousSibling?.textContent?.trim(),
      ),
    ).toBe("Overview");
    await expect(
      tracker.locator(
        '.volunteer-contents-sidebar [href="#application-personal-info"] svg',
      ),
    ).toHaveCSS("visibility", "hidden");

    if (width < 1024) {
      await tracker
        .locator(".volunteer-contents-sidebar")
        .getByRole("link", { name: "Emergency contact", exact: true })
        .click();
      await menu.locator("summary").click();
      await expect(reviewButton).toBeVisible();
      await reviewButton.click();
      await expect(form.locator('[name="firstName"]')).toBeFocused();
      await expect(form.locator("[data-application-review-step]")).toBeHidden();
      await expect(menu).not.toHaveAttribute("open");
      await expect(reviewButton).toBeHidden();
    }

    await bottomReview.click();
    await expect(form.locator('[name="firstName"]')).toBeFocused();
    await expect(form.locator("[data-application-review-step]")).toBeHidden();
    await form.locator('[name="training"][value="none"]').check();
    await expectComplete(page, "training-and-safety", true);

    for (const [name, value] of Object.entries({
      firstName: "Test",
      lastName: "Volunteer",
      phone: "6045550100",
      birthDate: "1990-01-01",
    }))
      await fillApplicationField(form, name, value);
    await expectComplete(page, "personal-info", true);
    await expect(count).toHaveText(["3/5 complete", "3/5 complete"]);
    await fillApplicationField(form, "birthDate", "2999-01-01");
    await expectComplete(page, "personal-info", false);
    await expect(count).toHaveText(["2/5 complete", "2/5 complete"]);
    await fillApplicationField(form, "birthDate", "1990-01-01");
    await form.locator('[name="firstName"]').fill("   ");
    await expectComplete(page, "personal-info", false);
    await form.locator('[name="firstName"]').fill("Test");
    await expectComplete(page, "personal-info", true);

    for (const [name, value] of Object.entries({
      emergencyName: "Contact",
      emergencyPhone: "6045550101",
      emergencyRelationship: "Friend",
    }))
      await form.locator(`[name="${name}"]`).fill(value);
    await expectComplete(page, "emergency-contact", true);
    await expect(count).toHaveText(["4/5 complete", "4/5 complete"]);
    await form.locator("#application-emergency-contact > summary").click();
    await expectComplete(page, "emergency-contact", true);

    await form.locator('[name="teams"][value="medic"]').check();
    await expectComplete(page, "training-and-safety", false);
    await expect(count).toHaveText(["3/5 complete", "3/5 complete"]);
    await form.locator('[name="certifications"][value="other"]').check();
    await form.locator('[name="certificationExpiry"]').fill("2030-01-01");
    await expectComplete(page, "training-and-safety", false);
    await form.locator('[name="experience"]').fill("Other medical training");
    await expectComplete(page, "training-and-safety", true);
    await form.locator('[name="training"][value="other"]').check();
    await expectComplete(page, "training-and-safety", false);
    await form.locator('[name="otherTraining"]').fill("Safety training");
    await expectComplete(page, "training-and-safety", true);
    await form.locator('[name="experience"]').fill("");
    await expectComplete(page, "training-and-safety", false);
    await form.locator('[name="teams"][value="medic"]').uncheck();
    await expectComplete(page, "training-and-safety", true);

    await form
      .locator('[name="motivation"]')
      .fill("I want to help my community.");
    await expectComplete(page, "about-volunteering", false);
    await form.locator('[name="heardAboutUsSources"][value="other"]').check();
    await expectComplete(page, "about-volunteering", false);
    await form.locator('[name="heardAboutUsOther"]').fill("A community event");
    await expectComplete(page, "about-volunteering", true);
    await expect(count).toHaveText(["5/5 complete", "5/5 complete"]);
    await form
      .locator('[name="motivation"]')
      .fill("word ".repeat(motivationMaxWords + 1));
    await expectComplete(page, "about-volunteering", false);
    await expect(count).toHaveText(["4/5 complete", "4/5 complete"]);
    await form
      .locator('[name="motivation"]')
      .fill("I want to help my community.");
    await expectComplete(page, "about-volunteering", true);

    if (width < 1024) await tracker.locator("summary").click();
    await tracker
      .getByRole("link", { name: "Emergency contact", exact: true })
      .click();
    await expect(
      form.locator("#application-emergency-contact"),
    ).toHaveAttribute("open", "");
    await expect(
      form.locator("#application-emergency-contact > summary"),
    ).toBeFocused();
    await expect(tracker.locator('[aria-current="location"]')).toHaveCount(2);
    if (width < 1024)
      await expect(tracker.locator("[data-contents-current]")).toHaveText(
        "Emergency contact",
      );

    if (width < 1024) {
      await expect(reviewButton).toBeHidden();
      await page.setViewportSize({ width, height: 360 });
      await menu.locator("summary").click();
      await reviewButton.scrollIntoViewIfNeeded();
    }
    await expect(reviewButton).toBeInViewport({ ratio: 1 });
    await reviewButton.click();
    await expect(form.locator("[data-application-review-step]")).toBeVisible();
    await expect(
      form.getByRole("heading", { name: "Review application", exact: true }),
    ).toBeFocused();
    await expect(tracker).toBeHidden();
    await expect(draftActions).toBeHidden();
    await form.getByRole("button", { name: "Back to answers" }).click();
    await expect(tracker).toBeVisible();
    await expect(
      form.locator("#application-personal-info > summary"),
    ).toBeFocused();
    if (width < 1024) {
      await expect(menu).not.toHaveAttribute("open");
      await expect(reviewButton).toBeHidden();
    }

    await expect(bottomReview).toBeVisible();
    await bottomReview.click();
    await expect(form.locator("[data-application-review-step]")).toBeVisible();
    await expect(form.locator('[data-review-answer="firstName"]')).toHaveText(
      "Test",
    );
    await expect(draftActions).toBeHidden();
    await page.goBack();
    await expect(bottomReview).toBeVisible();
    await expect(discard).toBeVisible();
    await expect(tracker).toBeVisible();

    await form.evaluate((element: HTMLFormElement) => element.reset());
    await expectComplete(page, "personal-info", false);
    await expectComplete(page, "emergency-contact", false);
    await expectComplete(page, "training-and-safety", false);
    await expectComplete(page, "about-volunteering", false);
    await expect(count).toHaveText(["1/5 complete", "1/5 complete"]);
    if (width >= 1024) {
      await page.setViewportSize({ width, height: 400 });
      await expect(reviewButton).toBeInViewport();
    }
  });
}

test("restored drafts initialize completion without showing validation errors", async ({
  page,
  baseURL,
}) => {
  const { id } = await createLocalAccount(page.request, baseURL!, false);
  const response = await page.request.put("/api/v1/account/application-draft", {
    headers: { origin: baseURL! },
    data: {
      userId: id,
      version: 1,
      revision: null,
      generation: null,
      answers: {
        emergencyName: "Saved contact",
        emergencyPhone: "6045550101",
        emergencyRelationship: "Friend",
        teams: ["outreach", "medic"],
      },
    },
  });
  expect(response.ok(), await response.text()).toBe(true);
  await page.goto("/apply");
  await expectComplete(page, "emergency-contact", true);
  await expectComplete(page, "training-and-safety", false);
  await expect(page.locator("[data-error]:visible")).toHaveCount(0);
});

test("mobile checklist scrolls away before the compact bar appears without a layout jump", async ({
  page,
  baseURL,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await createLocalAccount(page.request, baseURL!, false);
  await page.goto("/apply");
  await expect(page.locator(".site-header")).not.toHaveCSS(
    "position",
    "sticky",
  );
  const tracker = page.getByRole("navigation", {
    name: "Application progress",
  });
  const status = tracker.locator("[data-draft-save-indicator]");
  const compact = tracker.locator("[data-contents-bar]");
  const menu = tracker.locator("[data-contents-menu]");
  const dropdown = menu.locator("[data-contents-dropdown]");
  const reviewButton = dropdown.locator("[data-application-review]");
  const summary = tracker.locator("summary");
  const inline = tracker.locator(".volunteer-contents-inline-heading");
  await expect(tracker).not.toHaveAttribute("data-contents-sticky");
  await expect(inline).toBeVisible();
  await expect(menu).toBeHidden();
  await expect(
    tracker.locator(".volunteer-contents-sidebar > ol > li"),
  ).toHaveCount(6);
  const measure = () =>
    page.evaluate(() => {
      const nav = document
        .querySelector("[data-application-contents]")!
        .getBoundingClientRect();
      const form = document
        .querySelector("form[data-application]")!
        .getBoundingClientRect();
      return { navHeight: nav.height, formTop: form.top + scrollY };
    });
  const initial = await measure();
  const nav = (await tracker.boundingBox())!;
  const description = (await page
    .locator(".volunteer-application-intro")
    .boundingBox())!;
  expect(nav.y).toBe(description.y + description.height + 32);
  await page.evaluate(
    (top) => scrollTo({ top, behavior: "instant" }),
    nav.y + nav.height - 1,
  );
  await expect(tracker).not.toHaveAttribute("data-contents-sticky");
  await expect(menu).toBeHidden();
  await page.evaluate(
    (top) => scrollTo({ top, behavior: "instant" }),
    nav.y + nav.height + 16,
  );
  await expect(tracker).toHaveAttribute("data-contents-sticky", "");
  await expect.poll(async () => (await compact.boundingBox())!.y).toBe(0);
  expect(await measure()).toEqual(initial);
  await expect(summary.locator(".volunteer-contents-toggle")).toHaveCount(0);
  await expect(summary.locator("[data-application-progress-count]")).toHaveText(
    "1/5 complete",
  );
  await page.locator('[name="firstName"]').fill("Saved progress");
  await expect(status).toHaveText(/^Last saved at /);
  await expect.poll(async () => (await compact.boundingBox())!.y).toBe(0);
  await expect(page.locator(".site-header")).not.toBeInViewport();
  await expect(status).toBeInViewport();
  await expect(status).toHaveCSS("font-size", "14px");
  await expect(status).toHaveCSS("text-align", "right");
  await expect(status).toHaveCSS("justify-content", "flex-end");
  await expect(summary.locator("[data-application-progress-count]")).toHaveCSS(
    "font-size",
    "14px",
  );
  await expect(reviewButton).toBeHidden();
  expect((await status.boundingBox())!.y).toBeGreaterThanOrEqual(
    (await tracker.locator("summary").boundingBox())!.height,
  );
  const height = (await compact.boundingBox())!.height;
  expect(height).toBe(84);
  await tracker.locator("summary").click();
  expect((await compact.boundingBox())!.height).toBe(height);
  await expect(reviewButton).toBeVisible();
  const dropdownBounds = (await dropdown.boundingBox())!;
  const linksBounds = (await dropdown.locator("ol").boundingBox())!;
  expect(dropdownBounds.y).toBeGreaterThanOrEqual(height);
  expect((await reviewButton.boundingBox())!.y).toBeGreaterThanOrEqual(
    linksBounds.y + linksBounds.height,
  );
  await tracker
    .getByRole("link", { name: "Emergency contact", exact: true })
    .click();
  await expect(reviewButton).toBeHidden();
  await expect(
    page.locator("#application-emergency-contact > summary"),
  ).toBeFocused();
  await expect
    .poll(async () =>
      // scrollIntoView rounds scroll positions while layout can be fractional.
      Math.round(
        (await page.locator("#application-emergency-contact").boundingBox())!.y,
      ),
    )
    .toBeGreaterThanOrEqual(height + 16);
  await expect(page.locator("#application-emergency-contact")).toBeInViewport();
  await expect(summary.locator("[data-contents-current]")).toHaveText(
    "Emergency contact",
  );
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(
    390,
  );

  for (const viewport of [
    { width: 320, height: 360 },
    { width: 768, height: 400 },
  ]) {
    await page.setViewportSize(viewport);
    const bottomReview = localApplicationReviewButton(page, "bottom");
    await expect(bottomReview).toBeVisible();
    const bottomBounds = (await bottomReview.boundingBox())!;
    const discardBounds = (await page
      .locator("[data-draft-discard]")
      .boundingBox())!;
    const actionsBounds = (await bottomReview.locator("..").boundingBox())!;
    expect(bottomBounds.y + bottomBounds.height).toBeLessThan(discardBounds.y);
    for (const bounds of [bottomBounds, discardBounds]) {
      expect(bounds.x).toBe(actionsBounds.x);
      expect(bounds.width).toBe(actionsBounds.width);
      expect(bounds.x).toBeGreaterThanOrEqual(0);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(viewport.width);
      expect(bounds.width).toBeGreaterThanOrEqual(44);
      expect(bounds.height).toBeGreaterThanOrEqual(44);
    }
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBe(viewport.width);
    const current = await summary
      .locator(".volunteer-contents-section-toggle")
      .boundingBox();
    const count = await summary
      .locator("[data-application-progress-count]")
      .boundingBox();
    expect(current!.x + current!.width).toBeLessThanOrEqual(count!.x);
    await expect(
      summary.locator("[data-application-progress-count]"),
    ).toBeInViewport();
    await expect(reviewButton).toBeHidden();
    await tracker.locator("summary").click();
    await expect
      .poll(async () => {
        const bounds = (await dropdown.boundingBox())!;
        return bounds.y + bounds.height;
      })
      .toBeLessThanOrEqual(viewport.height - 16);
    expect((await compact.boundingBox())!.height).toBe(height);
    await menu
      .getByRole("link", { name: "About volunteering", exact: true })
      .focus();
    await page.keyboard.press("Tab");
    await expect(reviewButton).toBeFocused();
    await expect(reviewButton).toBeInViewport({ ratio: 1 });
    const action = (await reviewButton.boundingBox())!;
    expect(action.y).toBeGreaterThanOrEqual(height);
    expect(action.y + action.height).toBeLessThanOrEqual(viewport.height - 16);
    await page.keyboard.press("Escape");
    await expect(reviewButton).toBeHidden();
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => scrollTo({ top: 0, behavior: "instant" }));
  await expect(tracker).not.toHaveAttribute("data-contents-sticky");
  await expect(inline).toBeVisible();
  await expect(menu).toBeHidden();
  expect(await measure()).toEqual(initial);
});

test("inline mobile links clear the future bar and Overview restores the expanded checklist", async ({
  page,
  baseURL,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await createLocalAccount(page.request, baseURL!, false);
  await page.goto("/apply");
  const tracker = page.locator("[data-application-contents]");
  const compact = tracker.locator("[data-contents-bar]");
  const menu = tracker.locator("[data-contents-menu]");
  await tracker
    .locator(".volunteer-contents-sidebar")
    .getByRole("link", { name: "Emergency contact", exact: true })
    .click();
  await expect(tracker).toHaveAttribute("data-contents-sticky", "");
  await expect(compact).toHaveCSS("animation-name", "none");
  await expect(
    page.locator("#application-emergency-contact > summary"),
  ).toBeFocused();
  const bar = (await compact.boundingBox())!;
  await expect
    .poll(async () =>
      Math.round(
        (await page.locator("#application-emergency-contact").boundingBox())!.y,
      ),
    )
    .toBeGreaterThanOrEqual(bar.height + 16);
  await menu.locator("summary").press("Enter");
  await expect(menu).toHaveAttribute("open", "");
  await menu.getByRole("link", { name: "Overview", exact: true }).click();
  await expect.poll(() => page.evaluate(() => scrollY)).toBe(0);
  await expect(tracker).not.toHaveAttribute("data-contents-sticky");
  await expect(menu).not.toHaveAttribute("open");
  await expect(menu).toBeHidden();
  await expect(tracker.locator(".volunteer-contents-sidebar")).toBeVisible();
});
