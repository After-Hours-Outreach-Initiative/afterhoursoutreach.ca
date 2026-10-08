import { expect, test } from "@playwright/test";
import { createLocalAccount, sampleAnswers } from "../helpers/local-account";

test.beforeEach(async ({ page, baseURL }) => {
  test.skip(
    !baseURL?.startsWith("http://localhost:"),
    "Requires local D1 development",
  );
  // Keep persistent D1 rate limits real, but isolate each browser test from
  // previous test runs and the developer's own localhost sign-in requests.
  const ip = crypto.getRandomValues(new Uint8Array(2));
  await page.setExtraHTTPHeaders({
    "cf-connecting-ip": `198.18.${ip[0]}.${ip[1]}`,
  });
  await page.goto("/volunteer/sign-in");
  await expect(
    page.getByRole("button", { name: "Continue with Email" }),
  ).toBeVisible();
});

test("unfinished registration shows a clickable yellow warning card without clipping", async ({
  page,
  baseURL,
}) => {
  await page.goto("/volunteer");
  const warning = page.getByRole("link", {
    name: "Complete your registration to sign up for events",
    exact: true,
  });
  await expect(warning).toHaveCount(0);
  await createLocalAccount(page.request, baseURL!, false);
  await page.goto("/volunteer");
  await expect(warning).toBeVisible();
  await expect(warning).toHaveClass(/volunteer-registration-warning/);
  await expect(warning).toHaveAttribute("href", "/volunteer/register");
  await expect(warning).toHaveText(
    "Complete your registration to sign up for events",
  );
  await expect(warning).toHaveCSS("background-color", "rgb(33, 26, 8)");
  await expect(warning).toHaveCSS("border-top-color", "rgb(161, 98, 7)");
  const icon = warning.locator("svg.volunteer-warning-icon");
  await expect(icon).toBeVisible();
  await expect(icon).toHaveAttribute("aria-hidden", "true");
  await expect(icon).toHaveCSS("color", "rgb(250, 204, 21)");
  const arrow = warning.locator("svg.volunteer-registration-warning-arrow");
  await expect(arrow).toBeVisible();
  await expect(arrow).toHaveAttribute("aria-hidden", "true");
  const text = warning.locator(".volunteer-registration-warning-text");
  expect(
    await text.evaluate(
      (element) =>
        element.getBoundingClientRect().height <=
        Number.parseFloat(getComputedStyle(element).lineHeight) + 1,
    ),
  ).toBe(true);
  for (const width of [375, 320]) {
    await page.setViewportSize({ width, height: 812 });
    await expect(text).toHaveCSS("white-space", "normal");
    expect(
      await text.evaluate(
        (element) => element.scrollWidth <= element.clientWidth,
      ),
    ).toBe(true);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
    ).toBe(false);
  }
  await warning.focus();
  await warning.press("Enter");
  await expect(page).toHaveURL(/\/volunteer\/register$/);
  await page.goto("/volunteer");
  // The padding is clickable too, not just the text or arrow.
  await warning.click({ position: { x: 4, y: 4 } });
  await expect(page).toHaveURL(/\/volunteer\/register$/);
  const registered = await page.request.post("/api/account/profile", {
    headers: { origin: baseURL! },
    data: { ...sampleAnswers, codeOfConductAccepted: true },
  });
  expect(registered.status(), await registered.text()).toBe(200);
  await page.goto("/volunteer");
  await expect(warning).toHaveCount(0);
});

test("local D1 sign-in uses dialogs for delivery, errors and valid codes", async ({
  page,
}) => {
  const requests: string[] = [];
  page.on("request", (request) => {
    if (
      new URL(request.url()).pathname ===
      "/api/auth/email-otp/send-verification-otp"
    )
      requests.push(request.url());
  });
  await page
    .getByRole("textbox", { name: "Email", exact: true })
    .fill(`local-code-${crypto.randomUUID()}@example.org`);
  for (const outcome of ["Simulate delivery failure", "Simulate rate limit"]) {
    await page.getByRole("button", { name: "Continue with Email" }).click();
    await page.getByRole("button", { name: outcome }).click();
    await expect(
      page.locator("[data-email-request] [data-form-message]"),
    ).toContainText("Simulated locally");
  }
  expect(requests).toEqual([]);
  await page.getByRole("button", { name: "Continue with Email" }).click();
  await page
    .getByRole("button", { name: "Simulate successful delivery" })
    .click();
  const dialog = page.getByRole("dialog", { name: "Local sign-in email" });
  await expect(dialog).toBeVisible();
  const code = (await dialog.innerText()).match(/Your code is (\d{6})/)![1];
  await dialog.getByRole("button", { name: "Simulate wrong code" }).click();
  await expect(
    page.locator("[data-email-code] [data-form-message]"),
  ).toContainText("Invalid");
  await page.getByLabel("Six-digit code").fill(code);
  await page.getByRole("button", { name: "Sign in with code" }).click();
  await expect(page).toHaveURL(/\/volunteer\/register/);
  await expect(
    page.getByRole("navigation", { name: "Volunteer account" }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Volunteer registration" }),
  ).toBeVisible();
});

test("local D1 email links are one-use and sign-in pages have no third-party requests", async ({
  page,
  request,
}) => {
  const external: string[] = [];
  page.on("request", (req) => {
    if (new URL(req.url()).hostname !== "localhost") external.push(req.url());
  });
  await page.reload();
  await page
    .getByRole("textbox", { name: "Email", exact: true })
    .fill(`local-link-${crypto.randomUUID()}@example.org`);
  await page.getByRole("button", { name: "Continue with Email" }).click();
  await page
    .getByRole("button", { name: "Simulate successful delivery" })
    .click();
  const link = page.getByRole("link", { name: "Open local sign-in link" });
  const url = new URL((await link.getAttribute("href"))!);
  const proof = Object.fromEntries(new URLSearchParams(url.hash.slice(1)));
  await link.click();
  await expect(
    page.getByRole("button", { name: "Confirm sign-in" }),
  ).toBeEnabled();
  expect(new URL(page.url()).hash).toBe("");
  await page.getByRole("button", { name: "Confirm sign-in" }).click();
  await expect(page).toHaveURL(/\/volunteer\/register/);
  const replay = await request.post("/api/auth/sign-in/email-otp", {
    headers: { origin: url.origin },
    data: { email: proof.email, otp: proof.otp },
  });
  expect(replay.status()).toBe(400);
  expect(external).toEqual([]);
});
