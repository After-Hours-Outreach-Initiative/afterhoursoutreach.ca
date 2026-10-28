import { expect, test, type Page } from "@playwright/test";
import {
  createLocalAccount,
  signInLocalAuthenticatorAccount,
} from "../helpers/local-account";

test.beforeEach(async ({ page, baseURL }) => {
  test.skip(
    !baseURL?.startsWith("http://localhost:"),
    "Requires local development",
  );
  const ip = crypto.getRandomValues(new Uint8Array(2));
  await page.setExtraHTTPHeaders({
    "cf-connecting-ip": `198.18.${ip[0]}.${ip[1]}`,
  });
});

async function expectComingSoon(page: Page) {
  const settings = page.locator("[data-factor-settings]");
  await expect(settings).toHaveAttribute("aria-disabled", "true");
  await expect(
    settings.getByRole("heading", { name: "Two-factor authentication" }),
  ).toHaveCSS("color", "rgb(161, 161, 170)");
  await expect(
    settings.getByText("Coming soon.", { exact: true }),
  ).toBeVisible();
  await expect(
    settings.locator("form, button, input, summary, [data-factor-setup]"),
  ).toHaveCount(0);
}

test("authenticator settings are greyed out and setup is unavailable", async ({
  page,
  baseURL,
}) => {
  await createLocalAccount(page.request, baseURL!);
  await page.goto("/volunteer/account");
  for (const width of [1280, 375, 320]) {
    await page.setViewportSize({ width, height: 812 });
    await expectComingSoon(page);
  }
  const enabled = await page.request.post("/api/v1/auth/two-factor/enable", {
    headers: { origin: baseURL! },
    data: { method: "totp" },
  });
  expect(enabled.status()).toBe(404);
  const confirmed = await page.request.post(
    "/api/v1/auth/two-factor/verify-totp",
    {
      headers: { origin: baseURL! },
      data: { code: "123456" },
    },
  );
  expect(confirmed.status()).toBe(403);
});

test("existing authenticators stay enabled while settings are coming soon", async ({
  page,
  baseURL,
}) => {
  const user = await signInLocalAuthenticatorAccount(page.request, baseURL!);
  await page.goto("/volunteer/account");
  await expectComingSoon(page);
  await expect(page.locator("[data-factor-settings]")).toContainText(
    "Your authenticator is enabled. It is required each time you sign in.",
  );
  const current = await page.request.get("/api/v1/auth/get-session");
  const session = await current.json();
  expect(session.user.id).toBe(user.id);
  expect(session.user.twoFactorEnabled).toBe(true);
  expect(session.session.twoFactorVerified).toBe(true);
});
