import { expect, test } from "@playwright/test";

test.beforeEach(async ({ baseURL }) => {
  test.skip(
    !baseURL || !baseURL.startsWith("https://"),
    "Deployed Worker check only",
  );
});

test("deployed site uses real account features and shows a banner only on previews", async ({
  page,
  baseURL,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  for (const path of ["/", "/volunteer", "/about", "/donate"]) {
    await page.goto(path);
    const banner = page.getByRole("complementary", {
      name: "Preview environment",
    });
    if (
      new URL(baseURL!).hostname.endsWith(
        "-afterhoursoutreach-ca.ivanzheng9905.workers.dev",
      )
    ) {
      await expect(banner).toBeVisible();
      await expect(
        banner.getByRole("link", { name: "Visit the regular site" }),
      ).toHaveAttribute("href", "https://afterhoursoutreach.ca");
    } else {
      await expect(banner).toHaveCount(0);
    }
    await expect(
      page.locator(
        "[data-account-switcher], [data-event-teaser], [data-patrol-list], [data-view]",
      ),
    ).toHaveCount(0);
    await expect(
      page.getByRole("group", { name: "View as", exact: true }),
    ).toHaveCount(0);
  }
  expect(errors).toEqual([]);
  await page.goto("/patrols");
  await expect(page).toHaveURL(/\/volunteer\/?$/);
  await expect(
    page.locator("[data-account-switcher], [data-view]"),
  ).toHaveCount(0);
});

test("account and organizer routes require sign-in without loading mockups", async ({
  request,
}) => {
  for (const path of [
    "/volunteer/register",
    "/volunteer/account",
    "/volunteer/volunteers",
  ]) {
    const response = await request.get(path);
    expect(response.status()).toBe(200);
    expect(response.url()).toContain("/volunteer/sign-in");
    expect(await response.text()).not.toContain("data-account-switcher");
    expect(response.headers()["x-robots-tag"]).toContain("noindex");
  }
  expect((await request.get("/privacy")).status()).toBe(200);
});

test("private pages exclude indexing and the database is available", async ({
  request,
}) => {
  for (const path of ["/volunteer", "/volunteer/sign-in", "/privacy"]) {
    const response = await request.get(path);
    expect(response.status()).toBe(200);
    expect(response.headers()["x-robots-tag"]).toContain("noindex");
  }
  expect(await (await request.get("/api/health")).json()).toEqual({
    status: "ok",
  });
});

test("deployed sign-in is enabled with no third-party scripts or frames", async ({
  page,
  baseURL,
}) => {
  const origin = new URL(baseURL!).origin;
  const external: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).origin !== origin) external.push(request.url());
  });
  const response = await page.goto("/volunteer/sign-in");
  expect(response?.status()).toBe(200);
  expect(response?.headers()["content-security-policy"]).toContain(
    "frame-src 'none'",
  );
  await expect(
    page.getByRole("button", { name: "Continue with Email" }),
  ).toBeEnabled();
  await expect(
    page.getByRole("textbox", { name: "Email", exact: true }),
  ).toBeEnabled();
  await expect(page.locator("iframe")).toHaveCount(0);
  await expect(page.locator("[data-email-request] input")).toHaveCount(1);
  expect(external).toEqual([]);
});
