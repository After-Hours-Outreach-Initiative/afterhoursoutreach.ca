import { expect, test } from "@playwright/test";

test("email feedback preserves errors, retries only its operation, and closes silently on success", async ({
  page,
}) => {
  const operation = "56800536-96d1-4b07-a570-88dde73fc0f7";
  const submissions: object[] = [];
  let emailIssue = true;
  let release: () => void = () => {};
  let requested: () => void = () => {};
  const sending = new Promise<void>((resolve) => {
    requested = resolve;
  });
  const continueSend = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/v1/events/action", async (route) => {
    const body = route.request().postDataJSON();
    submissions.push(body);
    if (body.action !== "retry-notifications") {
      requested();
      await continueSend;
      await route.fulfill({
        json: emailIssue
          ? {
              message:
                "Registration removed. 1 email has unconfirmed delivery, possibly because the provider timed out.",
              sent: 2,
              pending: 1,
              unconfirmed: 1,
              retryOperation: operation,
            }
          : { message: "Registration removed.", sent: 3, pending: 0 },
      });
    } else if (submissions.length === 2) {
      await route.fulfill({
        status: 503,
        json: { message: "Email retry is unavailable." },
      });
    } else {
      await route.fulfill({
        json: {
          message:
            "Email retry complete. The registration change was not repeated.",
          sent: 3,
          pending: 0,
        },
      });
    }
  });
  await page.goto("/volunteer");
  await expect(page.locator("[data-event-notifications]")).toHaveCount(0);
  await page.evaluate(() => {
    const form = document.createElement("form");
    form.dataset.manageSignup = "";
    form.dataset.emailPrompt = "signup";
    form.innerHTML =
      '<input name="id" value="test-registration" type="hidden"><button type="submit" data-loading-label="Saving…">Remove test registration</button><p data-form-message hidden></p>';
    document.querySelector(".volunteer-wrap")!.appendChild(form);
  });
  await page.getByRole("button", { name: "Remove test registration" }).click();
  await page
    .getByRole("dialog", { name: "Send an email?", exact: true })
    .getByRole("button", { name: "Save and send email", exact: true })
    .click();
  await sending;
  await expect(
    page.getByRole("button", { name: "Sending…", exact: true }),
  ).toBeDisabled();
  await expect(
    page.locator("[data-manage-signup] [data-form-message]"),
  ).toHaveText("Sending…");
  release();
  const result = page.getByRole("dialog", {
    name: "Registration changed",
    exact: true,
  });
  await expect(result).toContainText("Registration removed.");
  await expect(result).not.toContainText("accepted");
  await expect(result).toContainText("unconfirmed delivery");
  await result
    .getByRole("button", { name: "Retry email only", exact: true })
    .click();
  await expect(result).toContainText(
    "The change remains saved. Email retry is unavailable. Do not repeat the saved change.",
  );
  await expect(
    result.getByRole("button", { name: "Retry email only", exact: true }),
  ).toBeEnabled();
  await result
    .getByRole("button", { name: "Retry email only", exact: true })
    .click();
  await expect(result).toHaveCount(0);
  emailIssue = false;
  const button = page.getByRole("button", { name: "Remove test registration" });
  await button.click();
  await page
    .getByRole("dialog", { name: "Send an email?", exact: true })
    .getByRole("button", { name: "Save and send email", exact: true })
    .click();
  await expect(button).toBeEnabled();
  await expect(page.locator("[data-action-email-feedback]")).toHaveCount(0);
  const message = page.locator("[data-manage-signup] [data-form-message]");
  await expect(message).toBeHidden();
  await expect(message).toHaveText("");
  expect(submissions).toEqual([
    {
      action: "manage-signup",
      id: "test-registration",
      reason: "",
      notify: true,
    },
    { action: "retry-notifications", operation },
    { action: "retry-notifications", operation },
    {
      action: "manage-signup",
      id: "test-registration",
      reason: "",
      notify: true,
    },
  ]);
});
