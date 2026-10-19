import { expect, test, type Locator, type Page } from "@playwright/test";
import { motivationMaxWords } from "../../src/data/application";
import {
  createLocalAccount,
  fillApplicationField,
  localApplicationReviewButton,
  localApplicationSaveIndicator,
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
    const icon = link.locator("svg");
    await expect(icon).toHaveAttribute("viewBox", "0 0 24 24");
    await expect(icon).toHaveAttribute("aria-hidden", "true");
    await expect(icon).toHaveAttribute("stroke-width", "2");
    await expect(icon.locator("circle")).toHaveAttribute("r", "10");
    await expect(icon).toHaveCSS(
      "color",
      complete ? "rgb(74, 222, 128)" : "rgb(161, 161, 170)",
    );
    await expect(icon.locator("path")).toHaveCSS(
      "visibility",
      complete ? "visible" : "hidden",
    );
  }
}

async function expectProgress(page: Page, completed: number) {
  const progress = page.locator("[data-application-progress]");
  await expect(progress).toHaveAttribute("role", "progressbar");
  await expect(progress).toHaveAttribute("aria-label", "Application progress");
  await expect(progress).toHaveAttribute("aria-valuemin", "0");
  await expect(progress).toHaveAttribute("aria-valuemax", "5");
  await expect(progress).toHaveAttribute("aria-valuenow", String(completed));
  await expect(progress).toHaveAttribute(
    "aria-valuetext",
    `${completed} of 5 sections complete`,
  );
  await expect(progress).toHaveAttribute(
    "data-complete",
    String(completed === 5),
  );
  await expect(progress).toHaveText("");
  await expect(progress).toHaveCSS("width", "28px");
  await expect(progress).toHaveCSS("height", "28px");
  await expect(progress.locator("svg")).toHaveAttribute("aria-hidden", "true");
  const value = progress.locator("[data-application-progress-value]");
  await expect(value).toHaveAttribute("pathLength", "100");
  await expect(value).toHaveAttribute("stroke-dasharray", "100");
  await expect(value).toHaveAttribute(
    "stroke-dashoffset",
    String(100 - completed * 20),
  );
  await expect(value).toHaveCSS(
    "stroke",
    completed === 5 ? "rgb(74, 222, 128)" : "rgb(129, 140, 248)",
  );
}

async function expectActionsPosition(page: Page) {
  const actions = page.getByRole("group", { name: "Review and discard" });
  await expect(actions).toBeInViewport({ ratio: 1 });
  await expect
    .poll(async () => {
      const bounds = (await actions.boundingBox())!;
      const height = page.viewportSize()!.height;
      const center = Math.min(height * 0.75, height - 16 - bounds.height / 2);
      return Math.abs(bounds.y + bounds.height / 2 - center);
    })
    .toBeLessThanOrEqual(1);
  const bounds = (await actions.boundingBox())!;
  const tracker = page.locator("[data-application-contents]");
  const menu = tracker.locator("[data-contents-menu]");
  const top = (await menu.isVisible())
    ? (await tracker.boundingBox())!.y + (await tracker.boundingBox())!.height
    : (await page.locator(".site-header").boundingBox())!.height;
  expect(bounds.y).toBeGreaterThanOrEqual(top + 16);
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(
    page.viewportSize()!.height - 16,
  );
  await expect(
    tracker.locator(
      '[href="#application-review-and-discard"][aria-current="location"]',
    ),
  ).toHaveCount(2);
}

async function expectFullDropdown(dropdown: Locator) {
  await expect(dropdown).toHaveCSS("max-height", "none");
  await expect(dropdown).toHaveCSS("overflow-y", "visible");
  expect(
    await dropdown.evaluate(
      (element) => element.scrollHeight - element.clientHeight,
    ),
  ).toBe(0);
  await expect(dropdown.getByRole("link")).toHaveCount(7);
  const bounds = (await dropdown.boundingBox())!;
  for (const control of await dropdown
    .locator("a, button, [role=status]")
    .all()) {
    const controlBounds = (await control.boundingBox())!;
    expect(controlBounds.y).toBeGreaterThanOrEqual(bounds.y);
    expect(controlBounds.y + controlBounds.height).toBeLessThanOrEqual(
      bounds.y + bounds.height,
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
    await page.goto("/apply#application-review-and-discard");
    const form = page.locator("form[data-application]");
    const tracker = page.getByRole("navigation", {
      name: "Sections",
    });
    const menu = tracker.locator("[data-contents-menu]");
    const reviewButton = localApplicationReviewButton(page);
    const bottomReview = localApplicationReviewButton(page, "bottom");
    const draftActions = page.locator("[data-application-draft-actions]");
    const discard = draftActions.locator("[data-draft-discard]");
    await expectActionsPosition(page);
    for (const id of ["overview", "review-and-discard"]) {
      const links = tracker.locator(`[href="#application-${id}"]`);
      await expect(links).toHaveCount(2);
      for (const link of await links.all()) {
        await expect(link).not.toHaveAttribute("data-complete");
        await expect(link).not.toHaveAttribute(
          "data-application-progress-link",
        );
        await expect(link).not.toHaveAttribute("aria-describedby");
        await expect(link).toHaveAccessibleDescription("");
        await expect(link.locator("svg")).toHaveCount(0);
        await expect(
          link.locator("..").locator("[data-application-completion-status]"),
        ).toHaveCount(0);
      }
    }
    await expect(
      tracker.locator("[data-application-progress-link]"),
    ).toHaveCount(10);
    if (width < 1024) await menu.locator("summary").click();
    await tracker.getByRole("link", { name: "Overview", exact: true }).click();
    await expect.poll(() => page.evaluate(() => scrollY)).toBe(0);
    await expectComplete(page, "personal-info", false);
    await expectComplete(page, "emergency-contact", false);
    await expectComplete(page, "team-interests", true);
    await expectComplete(page, "training-and-safety", false);
    await expectComplete(page, "about-volunteering", false);
    await expectProgress(page, 1);
    if (width < 1024)
      await expect(
        page.getByRole("progressbar", { name: "Application progress" }),
      ).toBeVisible();
    else await expect(page.locator("[data-application-progress]")).toBeHidden();
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
    const teamInterests = tracker.locator(
      `${width < 1024 ? "[data-contents-menu]" : ".volunteer-contents-sidebar"} [href="#application-team-interests"]`,
    );
    const checkmark = teamInterests.locator("svg");
    await expect(checkmark).toHaveCSS("color", "rgb(74, 222, 128)");
    await expect(checkmark).toHaveCSS("visibility", "visible");
    await expect(checkmark).toHaveCSS("border-width", "0px");
    expect(
      await teamInterests.evaluate((link) =>
        link.lastElementChild?.previousSibling?.textContent?.trim(),
      ),
    ).toBe("Team interests");
    await expect(
      tracker.locator(
        '.volunteer-contents-sidebar [href="#application-personal-info"] svg',
      ),
    ).toHaveCSS("visibility", "visible");

    if (width < 1024) await menu.locator("summary").click();
    await tracker
      .getByRole("link", { name: "Review and discard", exact: true })
      .click();
    await expectActionsPosition(page);
    await expect(
      page.getByRole("group", { name: "Review and discard" }),
    ).toBeFocused();
    await expect(form.locator("[data-application-review-step]")).toBeHidden();
    await expect(form.locator("[data-error]:visible")).toHaveCount(0);
    expect(await page.evaluate(() => history.state.applicationStep)).toBe(
      "questions",
    );
    await page.goBack();
    await expect.poll(() => page.evaluate(() => scrollY)).toBe(0);
    await page.goForward();
    await expectActionsPosition(page);
    await page.evaluate(() => scrollBy({ top: -120, behavior: "instant" }));
    await expect(
      tracker.locator(
        '[href="#application-review-and-discard"][aria-current="location"]',
      ),
    ).toHaveCount(0);

    if (width < 1024) {
      await menu.locator("summary").click();
      await menu
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
    await expectProgress(page, 3);
    await fillApplicationField(form, "birthDate", "2999-01-01");
    await expectComplete(page, "personal-info", false);
    await expectProgress(page, 2);
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
    await expectProgress(page, 4);
    await form.locator("#application-emergency-contact").click();
    await expect(form.locator('[name="emergencyName"]')).toBeVisible();
    await expectComplete(page, "emergency-contact", true);

    await form.locator('[name="teams"][value="medic"]').check();
    await expectComplete(page, "training-and-safety", false);
    await expectProgress(page, 3);
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
    await expectProgress(page, 5);
    await form
      .locator('[name="motivation"]')
      .fill("word ".repeat(motivationMaxWords + 1));
    await expectComplete(page, "about-volunteering", false);
    await expectProgress(page, 4);
    await form
      .locator('[name="motivation"]')
      .fill("I want to help my community.");
    await expectComplete(page, "about-volunteering", true);
    await expectProgress(page, 5);

    if (width < 1024) await tracker.locator("summary").click();
    await tracker
      .getByRole("link", { name: "Emergency contact", exact: true })
      .click();
    await expect(form.locator("#application-emergency-contact")).toBeFocused();
    await expect(form.locator('[name="emergencyName"]')).toBeVisible();
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
    await expect(form).toHaveCSS("border-top-width", "1px");
    await expect(form).toHaveCSS("border-radius", "10px");
    await expect(draftActions).toBeHidden();
    await form.getByRole("button", { name: "Back to answers" }).click();
    await expect(tracker).toBeVisible();
    await expect(form.locator("#application-personal-info")).toBeFocused();
    if (width < 1024) {
      await expect(menu).not.toHaveAttribute("open");
      await expect(reviewButton).toBeHidden();
      await expect(form).toHaveCSS("border-top-width", "0px");
      await expect(form).toHaveCSS("border-radius", "0px 0px 10px 10px");
    }

    await expect(bottomReview).toBeVisible();
    await bottomReview.click();
    await expect(form.locator("[data-application-review-step]")).toBeVisible();
    await expect(form.locator('[data-review-answer="firstName"]')).toHaveText(
      "Test",
    );
    await expect(draftActions).toBeHidden();
    await form.getByRole("button", { name: "Edit emergency contact" }).click();
    await expect(form.locator("#application-emergency-contact")).toBeFocused();
    await expect(form.locator('[name="emergencyName"]')).toHaveValue("Contact");
    await page.goForward();
    await expect(form.locator("[data-application-review-step]")).toBeVisible();
    await page.goBack();
    await expect(bottomReview).toBeVisible();
    await expect(discard).toBeVisible();
    await expect(tracker).toBeVisible();

    await form.evaluate((element: HTMLFormElement) => element.reset());
    await expectComplete(page, "personal-info", false);
    await expectComplete(page, "emergency-contact", false);
    await expectComplete(page, "training-and-safety", false);
    await expectComplete(page, "about-volunteering", false);
    await expectProgress(page, 1);
    await expect(
      form.locator(".volunteer-application-section > fieldset:visible"),
    ).toHaveCount(5);
    if (width >= 1024) {
      await page.setViewportSize({ width, height: 400 });
      await expect(reviewButton).toBeInViewport();
      await tracker
        .getByRole("link", { name: "Review and discard", exact: true })
        .click();
      await expectActionsPosition(page);
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
  await expectProgress(page, 2);
  await expect(
    page.locator(".volunteer-application-section > fieldset:visible"),
  ).toHaveCount(5);
  await expect(page.locator("[data-error]:visible")).toHaveCount(0);
});

test("one compact mobile tracker keeps its reading edge and lets tall menus scroll with the page", async ({
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
    name: "Sections",
  });
  const status = localApplicationSaveIndicator(page);
  const compact = tracker.locator("[data-contents-bar]");
  const menu = tracker.locator("[data-contents-menu]");
  const dropdown = menu.locator("[data-contents-dropdown]");
  const reviewButton = dropdown.locator("[data-application-review]");
  const summary = tracker.locator("summary");
  const current = summary.locator("[data-contents-current]");
  await expect(tracker).toHaveCSS("position", "sticky");
  await expect(compact).not.toHaveCSS("position", "fixed");
  await expect(menu).toBeVisible();
  await expect(menu).not.toHaveAttribute("open");
  await expect(
    summary.locator(".volunteer-contents-section-toggle"),
  ).toHaveText("Sections");
  await expect(current).toBeHidden();
  await expect(current).toHaveText("");
  await expect(tracker.locator(".volunteer-contents-sidebar")).toBeHidden();
  await expect(tracker.getByRole("link")).toHaveCount(0);
  const measure = () =>
    page.evaluate(() => {
      const nav = document
        .querySelector("[data-application-contents]")!
        .getBoundingClientRect();
      const form = document
        .querySelector("form[data-application]")!
        .getBoundingClientRect();
      const summary = document.querySelector("[data-contents-menu] > summary")!;
      const style = getComputedStyle(summary);
      return {
        navLeft: nav.left,
        navWidth: nav.width,
        navHeight: nav.height,
        border: style.borderWidth,
        formTop: form.top + scrollY,
      };
    });
  const initial = await measure();
  const nav = (await tracker.boundingBox())!;
  const description = (await page
    .locator(".volunteer-application-intro")
    .boundingBox())!;
  expect(nav.y).toBe(description.y + description.height + 32);
  const firstSection = page.locator("#application-personal-info");
  const firstTop = (await firstSection.boundingBox())!.y;
  for (const top of [64, nav.y - 1, nav.y + 1, firstTop - nav.height - 18]) {
    await page.evaluate((top) => scrollTo({ top, behavior: "instant" }), top);
    await expect
      .poll(async () => (await tracker.boundingBox())!.y)
      .toBe(Math.max(0, nav.y - Math.round(top)));
    await expect(current).toBeHidden();
    await expect(menu).toBeVisible();
    expect(await measure()).toEqual(initial);
  }
  for (const top of [firstTop - nav.height - 15, firstTop + 150]) {
    await page.evaluate((top) => scrollTo({ top, behavior: "instant" }), top);
    await expect(current).toHaveText("Personal info");
    await expect.poll(async () => (await compact.boundingBox())!.y).toBe(0);
    expect(await measure()).toEqual(initial);
  }
  await expect(summary.locator(".volunteer-contents-toggle")).toHaveCount(0);
  await expectProgress(page, 1);
  await page.locator('[name="firstName"]').fill("Saved progress");
  await expect(status).toHaveText(/^Last saved at /);
  await expect.poll(async () => (await compact.boundingBox())!.y).toBe(0);
  await expect(page.locator(".site-header")).not.toBeInViewport();
  await expect(status).toBeHidden();
  await expect(tracker.getByRole("status")).toHaveCount(0);
  await expect(status).toHaveCSS("font-size", "14px");
  await expect(status).toHaveCSS("text-align", "right");
  await expect(status).toHaveCSS("justify-content", "flex-end");
  await expect(reviewButton).toBeHidden();
  const height = (await compact.boundingBox())!.height;
  expect(height).toBe(54);
  expect((await summary.boundingBox())!.height).toBe(height);
  await expect(page.locator("[data-application-flow]")).toHaveAttribute(
    "style",
    /--contents-bar-height: 54px; --contents-scroll-offset: 54px;/,
  );
  await tracker.locator("summary").click();
  expect((await compact.boundingBox())!.height).toBe(height);
  await expectFullDropdown(dropdown);
  await expect(tracker).toHaveCSS("position", "sticky");
  await expect(summary).toHaveCSS("border-radius", "0px");
  await expect(menu).toHaveCSS("border-radius", "0px");
  await expect(summary).toHaveCSS("background-color", "rgb(23, 26, 32)");
  await expect(menu).toHaveCSS("background-color", "rgb(23, 26, 32)");
  await expect(dropdown).toBeInViewport({ ratio: 1 });
  await expect(reviewButton).toBeVisible();
  await expect(status).toBeVisible();
  await expect(tracker.getByRole("status")).toHaveCount(1);
  await expect(dropdown.getByRole("link").first()).toHaveCSS(
    "font-size",
    "18px",
  );
  const dropdownBounds = (await dropdown.boundingBox())!;
  const linksBounds = (await dropdown.locator("ol").boundingBox())!;
  expect(dropdownBounds.y).toBeGreaterThanOrEqual(height);
  expect((await reviewButton.boundingBox())!.y).toBeGreaterThanOrEqual(
    linksBounds.y + linksBounds.height,
  );
  const reviewBounds = (await reviewButton.boundingBox())!;
  expect((await status.boundingBox())!.y).toBeGreaterThanOrEqual(
    reviewBounds.y + reviewBounds.height,
  );
  expect(
    await status.evaluate((element) =>
      element.previousElementSibling?.hasAttribute("data-application-review"),
    ),
  ).toBe(true);
  await tracker
    .getByRole("link", { name: "Emergency contact", exact: true })
    .click();
  await expect(reviewButton).toBeHidden();
  await expect(status).toBeHidden();
  await expect(page.locator("#application-emergency-contact")).toBeFocused();
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
    { width: 320, height: 240 },
    { width: 320, height: 360 },
    { width: 768, height: 400 },
  ]) {
    await page.setViewportSize(viewport);
    await summary.click();
    await menu
      .getByRole("link", { name: "Review and discard", exact: true })
      .click();
    await expectActionsPosition(page);
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
      .locator("[data-contents-current]")
      .boundingBox();
    const progress = await summary
      .locator("[data-application-progress]")
      .boundingBox();
    expect(current!.x + current!.width).toBeLessThanOrEqual(progress!.x);
    if (viewport.width === 320)
      expect(
        await summary
          .locator("[data-contents-current]")
          .evaluate((element) => element.scrollWidth > element.clientWidth),
      ).toBe(true);
    await expect(
      summary.locator("[data-application-progress]"),
    ).toBeInViewport();
    await expect(reviewButton).toBeHidden();
    await tracker.locator("summary").click();
    await expect(tracker).toHaveCSS("position", "relative");
    await expect(tracker).not.toHaveAttribute("data-contents-stuck");
    await expect(menu).toHaveCSS("box-shadow", "none");
    await expect(dropdown).toHaveCSS("position", "static");
    await expect(dropdown).toHaveCSS("border-radius", "0px");
    await expectFullDropdown(dropdown);
    const expanded = (await dropdown.boundingBox())!;
    const form = (await page.locator("form[data-application]").boundingBox())!;
    expect(form.y).toBe(expanded.y + expanded.height);
    expect((await dropdown.boundingBox())!.height).toBeGreaterThan(
      viewport.height,
    );
    await expect(page.locator("[data-application-flow]")).toHaveAttribute(
      "style",
      /--contents-bar-height: 54px; --contents-scroll-offset: 54px;/,
    );
    // Native scrolling rounds fractional layout positions by less than a pixel.
    await expect(summary).toBeInViewport({ ratio: 0.99 });
    const menuScroll = await page.evaluate(() => scrollY);
    await menu
      .getByRole("link", { name: "Review and discard", exact: true })
      .focus();
    await page.keyboard.press("Tab");
    await expect(reviewButton).toBeFocused();
    await expect(reviewButton).toBeInViewport({ ratio: 1 });
    const action = (await reviewButton.boundingBox())!;
    expect(action.y).toBeGreaterThanOrEqual(0);
    expect(action.y + action.height).toBeLessThanOrEqual(viewport.height);
    expect(await page.evaluate(() => scrollY)).toBeGreaterThan(menuScroll);
    await expect(summary).not.toBeInViewport();
    await status.scrollIntoViewIfNeeded();
    await expect(status).toBeInViewport({ ratio: 1 });
    await expectFullDropdown(dropdown);
    await page.keyboard.press("Escape");
    await expect(reviewButton).toBeHidden();
    await expect(status).toBeHidden();
    await expect(summary).toBeFocused();
    await expect(tracker).toHaveCSS("position", "sticky");
    await expect(summary).toBeInViewport({ ratio: 1 });
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => scrollTo({ top: 0, behavior: "instant" }));
  await expect(current).toBeHidden();
  await expect(menu).toBeVisible();
  await expect(menu).not.toHaveAttribute("open");
  await expect(tracker.locator(".volunteer-contents-sidebar")).toBeHidden();
  expect(await measure()).toEqual(initial);
  const savedMessage = await status.textContent();
  await page.setViewportSize({ width: 1280, height: 900 });
  await expect(status).toBeHidden();
  const desktopStatus = localApplicationSaveIndicator(page);
  await expect(desktopStatus).toBeVisible();
  await expect(desktopStatus).toHaveText(savedMessage!.trim());
  await expect(tracker.getByRole("status")).toHaveCount(1);
});

test("the mobile dropdown works from its normal position and Overview restores Sections", async ({
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
  const summary = menu.locator("summary");
  const dropdown = menu.locator("[data-contents-dropdown]");
  const label = summary.locator(".volunteer-contents-section-toggle");
  const current = summary.locator("[data-contents-current]");
  const chevron = summary.locator(".volunteer-contents-chevron");
  const progress = summary.locator("[data-application-progress]");
  await expect(label).toHaveText("Sections");
  await expect(current).toBeHidden();
  await expect(
    summary.locator('button, a, [tabindex], [role="button"]'),
  ).toHaveCount(0);
  await expect(chevron).toHaveCSS("width", "24px");
  await expect(label).toHaveCSS("border-width", "0px");
  await expect(label).toHaveCSS("padding", "0px");
  await expect(label).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await expect(summary.locator(":scope > :last-child")).toHaveClass(
    "volunteer-contents-chevron",
  );
  for (const viewport of [
    { width: 320, height: 812 },
    { width: 375, height: 812 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(viewport);
    await page.evaluate(() => scrollTo({ top: 0, behavior: "instant" }));
    await expect(tracker).not.toHaveAttribute("data-contents-stuck");
    await expect(menu).toHaveCSS("box-shadow", "none");
    await expect(summary).toHaveCSS("border-width", "1px");
    await expect(summary).toHaveCSS("border-radius", "10px 10px 0px 0px");
    await expect(menu).toHaveCSS("border-radius", "10px 10px 0px 0px");
    await expect(current).toBeHidden();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBe(viewport.width);
    const initial = (await summary.boundingBox())!;
    const panel = page.locator("form[data-application]");
    await expect(panel).toHaveCSS("border-top-width", "0px");
    await expect(panel).toHaveCSS("border-radius", "0px 0px 10px 10px");
    const form = (await panel.boundingBox())!;
    expect(form.y).toBe(initial.y + initial.height);
    expect(initial.x).toBe(form.x);
    expect(initial.width).toBe(form.width);
    expect(initial.x).toBe(16);
    await page.evaluate(
      (top) => scrollTo({ top, behavior: "instant" }),
      initial.y + 1,
    );
    await expect(tracker).toHaveAttribute("data-contents-stuck", "");
    await expect(menu).not.toHaveCSS("box-shadow", "none");
    await expect(summary).toHaveCSS("border-width", "1px");
    await expect(summary).toHaveCSS("border-radius", "0px");
    await expect(menu).toHaveCSS("border-radius", "0px");
    expect(await summary.boundingBox()).toEqual({ ...initial, y: 0 });
    await page.evaluate(() => {
      const section = document
        .querySelector("#application-personal-info")!
        .getBoundingClientRect();
      scrollTo({ top: scrollY + section.top - 70, behavior: "instant" });
    });
    await expect(current).toHaveText("Personal info");
    await expect(current).toBeVisible();
    await expect(label).toHaveText("Sections");
    const labelBounds = (await label.boundingBox())!;
    const currentBounds = (await current.boundingBox())!;
    const progressBounds = (await progress.boundingBox())!;
    const chevronBounds = (await chevron.boundingBox())!;
    const summaryBounds = (await summary.boundingBox())!;
    expect(labelBounds.x + labelBounds.width).toBeLessThanOrEqual(
      currentBounds.x,
    );
    expect(currentBounds.x + currentBounds.width).toBeLessThanOrEqual(
      progressBounds.x,
    );
    expect(progressBounds.x + progressBounds.width).toBeLessThanOrEqual(
      chevronBounds.x,
    );
    expect(chevronBounds.x + chevronBounds.width).toBe(
      summaryBounds.x + summaryBounds.width - 13,
    );
    await expect(current).toHaveCSS("text-overflow", "ellipsis");
    expect(summaryBounds.height).toBe(54);
    // Every part of the row toggles the native summary.
    for (const target of [label, current, progress, chevron]) {
      await target.click();
      await expect(menu).toHaveAttribute("open", "");
      await expect(chevron).toHaveCSS(
        "transform",
        "matrix(-1, 0, 0, -1, 0, 0)",
      );
      await page.keyboard.press("Escape");
    }
    await summary.click({ position: { x: 3, y: 27 } });
    await expect(menu).toHaveAttribute("open", "");
    await page.keyboard.press("Escape");
    await expect(summary).toBeFocused();
    await expect(summary).not.toHaveCSS("box-shadow", "none");
    await page.evaluate(() => scrollTo({ top: 0, behavior: "instant" }));
    await expect(tracker).not.toHaveAttribute("data-contents-stuck");
    await expect(summary).toHaveCSS("border-radius", "10px 10px 0px 0px");
    await expect(menu).toHaveCSS("border-radius", "10px 10px 0px 0px");
    await summary.press("Enter");
    await expect(menu).toHaveAttribute("open", "");
    await expectFullDropdown(dropdown);
    await expect(tracker).toHaveCSS("position", "sticky");
    await expect(dropdown).toHaveCSS("position", "absolute");
    await expect(summary).toHaveCSS("border-radius", "10px 10px 0px 0px");
    await expect(dropdown).toHaveCSS("border-radius", "0px 0px 8px 8px");
    await expect(dropdown).toHaveCSS("border-top-width", "0px");
    const expanded = (await dropdown.boundingBox())!;
    const bar = (await summary.boundingBox())!;
    expect(expanded.x).toBe(initial.x);
    expect(expanded.width).toBe(initial.width);
    expect(expanded.y).toBe(bar.y + bar.height);
    await expect(summary).toBeInViewport({ ratio: 1 });
    await expect(dropdown).toBeInViewport({ ratio: 1 });
    await expect(dropdown.locator("[role=status]")).toBeInViewport({
      ratio: 1,
    });
    await page.keyboard.press("Escape");
    await expect(menu).not.toHaveAttribute("open");
  }
  await summary.press("Enter");
  await menu
    .getByRole("link", { name: "Emergency contact", exact: true })
    .click();
  await expect(menu).not.toHaveAttribute("open");
  await expect.poll(async () => (await compact.boundingBox())!.y).toBe(0);
  await expect(page.locator("#application-emergency-contact")).toBeFocused();
  const bar = (await compact.boundingBox())!;
  await expect
    .poll(async () =>
      Math.round(
        (await page.locator("#application-emergency-contact").boundingBox())!.y,
      ),
    )
    .toBeGreaterThanOrEqual(bar.height + 16);
  await summary.press("Enter");
  await expect(menu).toHaveAttribute("open", "");
  await expect(summary).toHaveCSS("border-radius", "0px");
  await expect(menu).toHaveCSS("border-radius", "0px");
  await menu.getByRole("link", { name: "Overview", exact: true }).click();
  await expect.poll(() => page.evaluate(() => scrollY)).toBe(0);
  await expect(summary).toHaveCSS("border-radius", "10px 10px 0px 0px");
  await expect(menu).toHaveCSS("border-radius", "10px 10px 0px 0px");
  await expect(menu).not.toHaveAttribute("open");
  await expect(menu).toBeVisible();
  await expect(label).toHaveText("Sections");
  await expect(current).toBeHidden();
  await expect(current).toHaveText("");
  await expect(tracker.locator(".volunteer-contents-sidebar")).toBeHidden();
  await summary.press("Space");
  await expect(menu).toHaveAttribute("open", "");
  await page.keyboard.press("Escape");
  await expect(menu).not.toHaveAttribute("open");
  await expect(summary).toBeFocused();
  await summary.press("Enter");
  await page.locator('[name="firstName"]').focus();
  await expect(menu).not.toHaveAttribute("open");
  await summary.press("Enter");
  await page.locator(".volunteer-application-intro").click();
  await expect(menu).not.toHaveAttribute("open");
});
