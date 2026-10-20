import { expect, test } from "@playwright/test";

test("email feedback is action-specific, shows Sending, and retries only its email operation", async ({
  page,
}) => {
  const operation = "56800536-96d1-4b07-a570-88dde73fc0f7";
  const submissions: object[] = [];
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
        json: {
          message:
            "Registration removed. 2 emails accepted by the email provider. 1 email has unconfirmed delivery, possibly because the provider timed out.",
          pending: 1,
          unconfirmed: 1,
          retryOperation: operation,
        },
      });
    } else {
      await route.fulfill({
        json: {
          message:
            "Email retry complete. The registration change was not repeated. 3 emails accepted by the email provider (inbox delivery is not confirmed).",
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
  await expect(result).toContainText("2 emails accepted");
  await expect(result).toContainText("unconfirmed delivery");
  await result
    .getByRole("button", { name: "Retry email only", exact: true })
    .click();
  await expect(result).toContainText("3 emails accepted");
  await expect(
    result.getByRole("button", { name: "Retry email only", exact: true }),
  ).toBeHidden();
  expect(submissions).toEqual([
    {
      action: "manage-signup",
      id: "test-registration",
      reason: "",
      notify: true,
    },
    { action: "retry-notifications", operation },
  ]);
  await result.getByRole("button", { name: "Close", exact: true }).click();
  await expect(result).toHaveCount(0);
});
