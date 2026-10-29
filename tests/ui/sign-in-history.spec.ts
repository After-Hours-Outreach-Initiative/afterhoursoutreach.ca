import { expect, test } from "@playwright/test";

test("only completed sign-ins are remembered and saved emails can be chosen or forgotten", async ({
  page,
  context,
  baseURL,
}) => {
  test.skip(
    !baseURL?.startsWith("http://localhost:"),
    "Requires local development",
  );
  const ip = crypto.getRandomValues(new Uint8Array(2));
  await page.setExtraHTTPHeaders({
    "cf-connecting-ip": `198.18.${ip[0]}.${ip[1]}`,
  });
  const email = `remember-${crypto.randomUUID()}@example.org`;
  const storageKey = "aho:sign-in-emails:v1";
  const history = page.locator("[data-sign-in-history]");
  const input = page.getByRole("textbox", { name: "Email", exact: true });
  const send = page.getByRole("button", { name: "Continue with Email" });

  await page.goto("/volunteer/sign-in");
  await expect(history).toBeHidden();
  await input.fill(email);
  await send.click();
  await page
    .getByRole("button", { name: "Simulate successful delivery" })
    .click();
  const preview = page.getByRole("dialog", { name: "Local sign-in email" });
  const body = await preview.locator(".local-email-body").textContent();
  const code = body!.match(/Your code is (\d{6})/)![1];
  await page.getByRole("button", { name: "Simulate wrong code" }).click();
  await expect(
    page.locator("[data-email-code] [data-form-message]"),
  ).toContainText("Invalid sign-in code");
  expect(
    await page.evaluate((key) => localStorage.getItem(key), storageKey),
  ).toBeNull();
  await page.getByLabel("Six-digit code").fill(code);
  await page.getByRole("button", { name: "Sign in with code" }).click();
  await expect(page).toHaveURL(/\/volunteer$/);
  expect(
    await page.evaluate((key) => localStorage.getItem(key), storageKey),
  ).toBe(JSON.stringify([email]));

  await context.clearCookies();
  await page.goto("/volunteer/sign-in");
  await expect(history).toBeVisible();
  await history.getByRole("button", { name: email, exact: true }).click();
  await expect(input).toHaveValue(email);
  await expect(input).toBeFocused();
  await expect(page.locator("[data-email-code]")).toBeHidden();
  // This second delivery only checks the UI transition, not the server resend cooldown.
  await page.route(
    "**/api/v1/auth/email-otp/send-verification-otp**",
    (route) => route.fulfill({ json: { success: true } }),
  );
  await send.click();
  await page
    .getByRole("button", { name: "Simulate successful delivery" })
    .click();
  await expect(history).toBeHidden();
  await page.getByRole("link", { name: "Use a different email" }).click();
  await expect(history).toBeVisible();
  await page.getByRole("button", { name: "Forget saved emails" }).click();
  await expect(history).toBeHidden();
  await expect(input).toBeFocused();
  expect(
    await page.evaluate((key) => localStorage.getItem(key), storageKey),
  ).toBeNull();
  await page.reload();
  await expect(history).toBeHidden();
});
