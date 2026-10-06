import { expect, test } from "@playwright/test";

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
    page.getByRole("complementary", { name: "Development account controls" }),
  ).toBeVisible();
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
    .getByLabel("Email address")
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
    .getByLabel("Email address")
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
