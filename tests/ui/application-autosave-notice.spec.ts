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
  test(`autosave privacy notice precedes unanswered application fields on ${layout}`, async ({
    page,
    baseURL,
  }) => {
    await page.setViewportSize(viewport);
    await createLocalAccount(page.request, baseURL!, false);
    await page.goto("/apply");

    const notice = page.getByRole("complementary", {
      name: "Draft saving and privacy",
      exact: true,
    });
    await expect(notice).toBeVisible();
    await expect(notice.getByRole("heading")).toBeInViewport();
    await expect(notice).toContainText(
      "including any personal and medical information—is automatically saved before submission",
    );
    await expect(notice).toContainText(
      "stored with your account on our server (Cloudflare D1)",
    );
    await expect(notice).toContainText("resume on another device");
    await expect(notice).toContainText(
      "this browser’s local storage on this device when available",
    );
    await expect(notice).toContainText(
      "Offline or unsynced answers may be stored only in this browser",
    );
    await expect(notice).toContainText(
      "Signing out clears synced browser copies, but keeps your account draft and leaves unsynced answers on this device",
    );
    await expect(notice).toContainText("Avoid shared devices");
    await expect(notice).toContainText(
      "clearing this site’s browser data does not delete your account draft",
    );
    await expect(notice).toContainText("Saving a draft is not submission");
    await expect(notice).toContainText(
      "Drafts are not shown in organizer views",
    );
    await expect(notice).toContainText(
      "submitted for review only when you choose Submit application",
    );

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

    const privacyLink = notice.getByRole("link", {
      name: "privacy information",
      exact: true,
    });
    await expect(privacyLink).toHaveAttribute("href", "/privacy");
    await privacyLink.click();
    await expect(page).toHaveURL(/\/privacy$/);
    await expect(
      page.getByRole("heading", { name: "Privacy", exact: true }),
    ).toBeVisible();
  });
}

test("autosave privacy notice is present before answers without JavaScript", async ({
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
    const notice = page.getByRole("complementary", {
      name: "Draft saving and privacy",
      exact: true,
    });
    await expect(notice).toBeVisible();
    await expect(notice).toContainText("saved before submission");
    await expect(notice.getByRole("link")).toHaveAttribute("href", "/privacy");
    await expect(page.locator('[name="firstName"]')).toHaveValue("");
    await expect(
      page.getByRole("button", { name: "Review application", exact: true }),
    ).toBeDisabled();
  } finally {
    await context.close();
  }
});
