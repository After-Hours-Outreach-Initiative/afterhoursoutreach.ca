import { expect, test } from "@playwright/test";
import {
  createLocalAccount,
  localApplicationReviewButton,
  localApplicationSaveIndicator,
} from "../helpers/local-account";

test.beforeEach(({ baseURL }) => {
  test.skip(
    !baseURL?.startsWith("http://localhost:"),
    "Requires local development",
  );
});

for (const [layout, viewport] of [
  ["desktop", { width: 1280, height: 900 }],
  ["mobile", { width: 390, height: 844 }],
] as const) {
  for (const saved of [false, true]) {
    test(`save status does not shift the form when scripts load for a ${saved ? "saved" : "new"} draft on ${layout}`, async ({
      page,
      baseURL,
    }) => {
      await page.setViewportSize(viewport);
      const { id } = await createLocalAccount(page.request, baseURL!, false);
      if (saved) {
        const response = await page.request.put(
          "/api/v1/account/application-draft",
          {
            headers: { origin: baseURL! },
            data: {
              userId: id,
              version: 1,
              revision: null,
              generation: null,
              answers: { firstName: "Saved answer" },
            },
          },
        );
        expect(response.ok(), await response.text()).toBe(true);
      }
      let release!: () => void;
      const scripts = new Promise<void>((resolve) => (release = resolve));
      await page.route("**/*", async (route) => {
        if (route.request().resourceType() === "script") await scripts;
        await route.continue();
      });
      const measure = () =>
        page.evaluate(() => {
          const bar = document
            .querySelector("[data-contents-bar]")!
            .getBoundingClientRect();
          const form = document
            .querySelector("form[data-application]")!
            .getBoundingClientRect();
          return {
            barHeight: bar.height,
            formTop: form.top + scrollY,
          };
        });
      try {
        await page.goto("/apply", { waitUntil: "commit" });
        const indicator = localApplicationSaveIndicator(page);
        const bottomIndicator = page.locator(
          "[data-application-draft-actions] [data-draft-save-indicator]",
        );
        const statusHeight = layout === "mobile" ? 21 : 24;
        await expect(indicator).toHaveCSS("min-height", `${statusHeight}px`);
        await expect(indicator).toBeHidden();
        await expect(bottomIndicator).toBeHidden();
        await page.evaluate(() => document.fonts.ready);
        const initial = await measure();
        if (layout === "mobile") {
          await page.locator("[data-application-contents] summary").click();
        }
        expect((await indicator.boundingBox())!.height).toBe(statusHeight);

        release();
        await page.waitForLoadState("load");
        await expect(indicator).toHaveAttribute(
          "data-save-state",
          saved ? "saved" : "idle",
        );
        await expect(indicator).toHaveText(saved ? /^Last saved at / : "");
        await expect(indicator).toBeVisible();
        await expect(bottomIndicator).toHaveAttribute(
          "data-save-state",
          saved ? "saved" : "idle",
        );
        await expect(
          bottomIndicator.locator("[data-draft-save-message]"),
        ).toHaveText(
          await indicator.locator("[data-draft-save-message]").innerText(),
        );
        await expect(bottomIndicator).toBeVisible();
        await expect(bottomIndicator).toHaveCSS("font-size", "14px");
        await expect(bottomIndicator).toHaveCSS("font-weight", "400");
        await expect(
          page.getByText(
            "Your answers are saved to your account and this browser as you fill them in. See our privacy policy.",
            { exact: true },
          ),
        ).toHaveCSS("font-size", "16px");
        const statusFontSize = layout === "mobile" ? "14px" : "16px";
        await expect(indicator).toHaveCSS("font-size", statusFontSize);
        await expect(indicator.locator("[data-draft-save-message]")).toHaveCSS(
          "font-size",
          statusFontSize,
        );
        if (saved) {
          await expect(indicator.locator("svg")).toBeVisible();
          await expect(indicator.locator("svg")).toHaveAttribute(
            "aria-hidden",
            "true",
          );
          await expect(indicator).toHaveCSS("color", "rgb(161, 161, 170)");
        } else {
          await expect(indicator.locator("svg")).toBeHidden();
        }
        expect(await measure()).toEqual(initial);
      } finally {
        release();
      }
    });
  }

  test(`autosave status is in the progress tracker on ${layout}`, async ({
    page,
    baseURL,
  }) => {
    await page.setViewportSize(viewport);
    await createLocalAccount(page.request, baseURL!, false);
    await page.goto("/apply");

    const notice = page.getByText(
      "Your answers are saved to your account and this browser as you fill them in. See our privacy policy.",
      { exact: true },
    );
    await expect(notice).toBeVisible();
    await expect(notice).toBeInViewport();
    const tracker = page.getByRole("navigation", {
      name: "Sections",
    });
    const saveIndicator = localApplicationSaveIndicator(page);
    if (layout === "mobile") {
      await expect(saveIndicator).toBeHidden();
      await expect(tracker.getByRole("status")).toHaveCount(0);
      await tracker.locator("summary").click();
    }
    await expect(saveIndicator).toHaveAttribute("data-save-state", "idle");
    await expect(saveIndicator).toHaveText("");
    await expect(saveIndicator).toBeVisible();
    await expect(saveIndicator).toHaveAttribute("role", "status");
    await expect(saveIndicator).toHaveAttribute("aria-live", "polite");
    await expect(page.locator("[data-draft-save-indicator]")).toHaveCount(3);
    await expect(tracker.getByRole("status")).toHaveCount(1);
    expect(
      await page
        .locator("[data-application-draft-actions] [data-draft-save-indicator]")
        .evaluate((element) => {
          const group = element.previousElementSibling!;
          const bounds = element.getBoundingClientRect();
          const groupBounds = group.getBoundingClientRect();
          return (
            group.id === "application-review-and-discard" &&
            group.getAttribute("role") === "group" &&
            group.querySelectorAll("button").length === 2 &&
            element.nextElementSibling?.hasAttribute(
              "data-draft-discard-status",
            ) &&
            bounds.left === groupBounds.left &&
            bounds.top === groupBounds.bottom + 12
          );
        }),
    ).toBe(true);
    expect(
      await saveIndicator.evaluate((element) =>
        element.previousElementSibling?.hasAttribute("data-application-review"),
      ),
    ).toBe(true);
    await expect(
      page.getByRole("heading", {
        name: "Draft saving and privacy",
        exact: true,
      }),
    ).toHaveCount(0);

    const form = page.locator("form[data-application]");
    await expect(form.locator('[name="firstName"]')).toHaveValue("");
    expect(
      await notice.evaluate((element) => {
        const form = document.querySelector("form[data-application]")!;
        return (
          !element.closest("form") &&
          Boolean(
            element.compareDocumentPosition(form) &
            Node.DOCUMENT_POSITION_FOLLOWING,
          ) &&
          element.getBoundingClientRect().bottom <=
            form.getBoundingClientRect().top
        );
      }),
    ).toBe(true);
    await expect(form.locator("[data-application-review-step]")).toBeHidden();

    const draftResponse = await page.request.get(
      "/api/v1/account/application-draft",
    );
    expect(draftResponse.ok()).toBe(true);
    expect(await draftResponse.json()).toMatchObject({
      submitted: false,
      draft: null,
    });
  });
}

test("timestamp icons show save state without replacing normal TOC progress or save history", async ({
  page,
  baseURL,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await createLocalAccount(page.request, baseURL!, false);
  let releaseFirst!: () => void;
  const firstSave = new Promise<void>((resolve) => (releaseFirst = resolve));
  let releaseFailed!: () => void;
  const failedSave = new Promise<void>((resolve) => (releaseFailed = resolve));
  let releaseRetry!: () => void;
  const retrySave = new Promise<void>((resolve) => (releaseRetry = resolve));
  let requests = 0;
  await page.route("**/api/v1/account/application-draft", async (route) => {
    if (route.request().method() === "PUT") {
      const attempt = ++requests;
      if (attempt === 1) await firstSave;
      if (attempt === 2) {
        await failedSave;
        await route.fulfill({ status: 503, body: "Save unavailable" });
        return;
      }
      if (attempt === 3) await retrySave;
    }
    await route.continue();
  });
  try {
    await page.goto("/apply");
    const confirmation = page.locator(
      "[data-application-draft-actions] [data-draft-save-indicator]",
    );
    const message = confirmation.locator("[data-draft-save-message]");
    const announcement = confirmation.locator("[data-draft-save-announcement]");
    const icon = confirmation.locator("svg");
    const check = icon.locator(".cloud-save-saved");
    const loading = icon.locator(".cloud-save-loading");
    const menu = page.locator(
      "[data-application-contents] [data-contents-menu]",
    );
    const progress = menu.locator("[data-application-progress]");
    const expectNormalToc = async () => {
      await expect(progress).toBeVisible();
      await expect(
        menu.locator("[data-application-conflict-warning]"),
      ).toBeHidden();
      await expect(menu.locator("[data-draft-save-summary]")).toHaveCount(0);
      await expect(
        menu.locator("summary .volunteer-draft-save-icon"),
      ).toHaveCount(0);
    };
    await expect(confirmation).toHaveAttribute("data-save-state", "idle");
    await expect(confirmation).toHaveAttribute("role", "status");
    await expect(confirmation).toHaveAttribute("aria-live", "polite");
    await expect(icon).toBeHidden();
    await expectNormalToc();

    await page.locator('[name="firstName"]').fill("Saved answer");
    await expect.poll(() => requests).toBe(1);
    await expect(confirmation).toHaveAttribute("data-save-state", "loading");
    await expect(message).toHaveText("");
    await expect(loading).toBeVisible();
    await expect(announcement).toHaveText("Saving changes");
    await page.emulateMedia({ reducedMotion: "reduce" });
    await expect(loading).toHaveCSS("animation-name", "none");
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await expect(loading).toHaveCSS("animation-name", "volunteer-loading");
    await expectNormalToc();
    releaseFirst();
    await expect(confirmation).toHaveAttribute("data-save-state", "saved");
    await expect(message).toHaveText(/^Last saved at /);
    await expect(icon).toBeVisible();
    await expect(check).toBeVisible();
    await expect(loading).toBeHidden();
    await expect(icon).toHaveAttribute("aria-hidden", "true");
    await expect(menu).not.toHaveAttribute("open");
    await expectNormalToc();

    const savedMessage = await message.textContent();
    await page.locator('[name="firstName"]').fill("Newer answer");
    await expect.poll(() => requests).toBe(2);
    await expect(confirmation).toHaveAttribute("data-save-state", "loading");
    await expect(message).toHaveText(savedMessage!);
    await expect(loading).toBeVisible();
    await expect(check).toBeHidden();
    await expectNormalToc();
    releaseFailed();
    await expect(confirmation).toHaveAttribute("data-save-state", "error");
    await expect(message).toHaveText(savedMessage!);
    await expect(icon.locator(".cloud-save-error")).toBeVisible();
    await expect(loading).toBeHidden();
    await expect(announcement).toHaveText(". Couldn’t save to your account");
    await expect(page.locator("[data-draft-status]")).toContainText(
      "Retrying automatically",
    );
    await expect(
      page.getByRole("button", { name: "Retry saving" }),
    ).toBeVisible();
    await expectNormalToc();
    await expect.poll(() => requests).toBe(3);
    await expect(confirmation).toHaveAttribute("data-save-state", "loading");
    await expect(message).toHaveText(savedMessage!);
    await expect(loading).toBeVisible();
    await expect(check).toBeHidden();
    releaseRetry();
    await expect(confirmation).toHaveAttribute("data-save-state", "saved");
    await expect(icon).toBeVisible();
    await expect(check).toBeVisible();
    await expect(announcement).toHaveText(". All changes saved");
    await expect(page.locator("[data-draft-status-panel]")).toBeHidden();
    await expectNormalToc();
  } finally {
    releaseFirst();
    releaseFailed();
    releaseRetry();
  }
});

test("autosave message is present before answers without JavaScript", async ({
  browser,
  baseURL,
}) => {
  const context = await browser.newContext({
    baseURL,
    javaScriptEnabled: false,
    reducedMotion: "reduce",
  });
  try {
    await createLocalAccount(context.request, baseURL!, false);
    const page = await context.newPage();
    await page.goto("/apply");
    const notice = page.getByText(
      "Your answers are saved to your account and this browser as you fill them in. See our privacy policy.",
      { exact: true },
    );
    await expect(notice).toBeVisible();
    for (const viewport of [
      { width: 390, height: 844 },
      { width: 320, height: 240 },
      { width: 1280, height: 844 },
    ]) {
      await page.setViewportSize(viewport);
      if (viewport.width < 1024) {
        const menu = page.locator(
          "[data-application-contents] [data-contents-menu]",
        );
        const dropdown = menu.locator("[data-contents-dropdown]");
        const bar = page.locator(
          "[data-application-contents] [data-contents-bar]",
        );
        const barHeight = (await bar.boundingBox())!.height;
        if ((await menu.getAttribute("open")) === null) {
          await menu.locator("summary").click();
        }
        await expect(page.locator("[data-application-contents]")).toHaveCSS(
          "position",
          "sticky",
        );
        await expect(
          menu.locator(".volunteer-contents-dropdown-band"),
        ).toHaveCSS("position", "absolute");
        await expect(dropdown).toHaveCSS(
          "max-height",
          `${viewport.height - barHeight}px`,
        );
        await expect(dropdown).toHaveCSS("overflow-y", "auto");
        await expect(dropdown.getByRole("link")).toHaveCount(7);
        await menu.locator("summary").scrollIntoViewIfNeeded();
        if (viewport.height === 240)
          await menu.evaluate((element) =>
            scrollTo({
              top: scrollY + element.getBoundingClientRect().top,
              behavior: "instant",
            }),
          );
        await menu
          .locator("summary")
          .evaluate((element: HTMLElement) =>
            element.focus({ preventScroll: true }),
          );
        const beforeToggle = await page.evaluate(() => scrollY);
        await menu.locator("summary").press("Enter");
        await expect(menu).not.toHaveAttribute("open");
        expect(await page.evaluate(() => scrollY)).toBe(beforeToggle);
        await menu.locator("summary").press("Space");
        await expect(menu).toHaveAttribute("open", "");
        expect(await page.evaluate(() => scrollY)).toBe(beforeToggle);
        const lastLink = dropdown.getByRole("link").last();
        await lastLink.focus();
        await expect(lastLink).toBeFocused();
        if (viewport.height === 240) {
          expect((await dropdown.boundingBox())!.height).toBe(
            viewport.height - barHeight,
          );
          expect(
            await dropdown.evaluate((element) => element.scrollTop),
          ).toBeGreaterThan(0);
          await expect(lastLink).toBeInViewport({ ratio: 1 });
          expect(await page.evaluate(() => scrollY)).toBe(beforeToggle);
        } else
          expect(
            await dropdown.evaluate(
              (element) => element.scrollHeight - element.clientHeight,
            ),
          ).toBe(0);
      }
      for (const indicator of await page
        .locator("[data-draft-save-indicator]")
        .all())
        await expect(indicator).toBeHidden();
      await expect(
        page.locator("[data-application-conflict-warning]"),
      ).toBeHidden();
    }
    await expect(page.locator('[name="firstName"]')).toHaveValue("");
    await expect(localApplicationReviewButton(page, "bottom")).toBeDisabled();
  } finally {
    await context.close();
  }
});
