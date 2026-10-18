import { expect, test } from "@playwright/test";
import { createLocalAccount } from "../helpers/local-account";

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
    test(`save status reserves its space before scripts load for a ${saved ? "saved" : "new"} draft on ${layout}`, async ({
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
          const status = document
            .querySelector("[data-draft-save-indicator]")!
            .getBoundingClientRect();
          const form = document
            .querySelector("form[data-application]")!
            .getBoundingClientRect();
          return {
            statusTop: status.top + scrollY,
            statusHeight: status.height,
            formTop: form.top + scrollY,
          };
        });
      try {
        await page.goto("/apply", { waitUntil: "commit" });
        const indicator = page.locator("[data-draft-save-indicator]");
        await expect(indicator).toHaveCSS("min-height", "24px");
        await expect(indicator).toBeHidden();
        await page.evaluate(() => document.fonts.ready);
        const initial = await measure();
        expect(initial.statusHeight).toBe(24);

        release();
        await page.waitForLoadState("load");
        await expect(indicator).toHaveAttribute(
          "data-save-state",
          saved ? "saved" : "idle",
        );
        await expect(indicator).toHaveText(saved ? /^Last saved at / : "");
        await expect(indicator).toBeVisible();
        const listFontSize = await page
          .locator(".volunteer-application-intro li")
          .first()
          .evaluate((element) => getComputedStyle(element).fontSize);
        await expect(
          page.getByText(
            "Your application progress is automatically saved to your account.",
            { exact: true },
          ),
        ).toHaveCSS("font-size", listFontSize);
        await expect(indicator).toHaveCSS("font-size", listFontSize);
        await expect(indicator.locator("[data-draft-save-message]")).toHaveCSS(
          "font-size",
          listFontSize,
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

  test(`autosave message precedes unanswered application fields on ${layout}`, async ({
    page,
    baseURL,
  }) => {
    await page.setViewportSize(viewport);
    await createLocalAccount(page.request, baseURL!, false);
    await page.goto("/apply");

    const notice = page.getByText(
      "Your application progress is automatically saved to your account.",
      { exact: true },
    );
    await expect(notice).toBeVisible();
    await expect(notice).toBeInViewport();
    const saveIndicator = page.locator("[data-draft-save-indicator]");
    await expect(saveIndicator).toHaveAttribute("data-save-state", "idle");
    await expect(saveIndicator).toHaveText("");
    await expect(saveIndicator).toBeVisible();
    await expect(saveIndicator).toHaveAttribute("role", "status");
    await expect(saveIndicator).toHaveAttribute("aria-live", "polite");
    expect(
      await saveIndicator.evaluate((element) => {
        const notice = element.previousElementSibling!;
        const form = document.querySelector("form[data-application]")!;
        return (
          notice.textContent?.trim() ===
            "Your application progress is automatically saved to your account." &&
          element.getBoundingClientRect().top >=
            notice.getBoundingClientRect().bottom &&
          element.getBoundingClientRect().bottom <=
            form.getBoundingClientRect().top
        );
      }),
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

test("autosave message is present before answers without JavaScript", async ({
  browser,
  baseURL,
}) => {
  const context = await browser.newContext({
    baseURL,
    javaScriptEnabled: false,
  });
  try {
    await createLocalAccount(context.request, baseURL!, false);
    const page = await context.newPage();
    await page.goto("/apply");
    const notice = page.getByText(
      "Your application progress is automatically saved to your account.",
      { exact: true },
    );
    await expect(notice).toBeVisible();
    await expect(page.locator("[data-draft-save-indicator]")).toBeHidden();
    await expect(page.locator('[name="firstName"]')).toHaveValue("");
    await expect(
      page.getByRole("button", { name: "Review application", exact: true }),
    ).toBeDisabled();
  } finally {
    await context.close();
  }
});
