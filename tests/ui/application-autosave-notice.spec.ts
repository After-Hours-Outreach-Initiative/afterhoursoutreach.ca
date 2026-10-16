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
    await expect(saveIndicator).toHaveText("Ready to save");
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
