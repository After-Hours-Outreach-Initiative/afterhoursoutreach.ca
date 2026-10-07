import { expect, test } from "@playwright/test";
import {
  createLocalAccount,
  openLocalAccountSwitcher,
} from "../helpers/local-account";
import { totpFromSetupKey } from "../helpers/totp";

test.beforeEach(async ({ page, baseURL }) => {
  test.skip(
    !baseURL?.startsWith("http://localhost:"),
    "Local D1 development only",
  );
  await page.goto("/volunteer");
});

test("volunteer-page sign-in is usable on mobile and opens the shared code form", async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 812 });
  const emails: string[] = [];
  await page.route("**/api/auth/email-otp/send-verification-otp**", (route) => {
    emails.push(route.request().postDataJSON().email);
    return route.fulfill({ json: { success: true } });
  });
  await page
    .getByRole("textbox", { name: "Email", exact: true })
    .fill("mobile@example.org");
  await page.getByRole("button", { name: "Continue with Email" }).click();
  await page
    .getByRole("button", { name: "Simulate successful delivery" })
    .click();
  await expect(page.getByLabel("Six-digit code")).toBeVisible();
  await expect(page.getByLabel("Six-digit code")).toBeFocused();
  expect(emails).toEqual(["mobile@example.org"]);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
  ).toBe(false);
});

test("event type buttons filter instantly, preserve deep links, and never submit a confirmation form", async ({
  page,
}) => {
  const documents: string[] = [];
  page.on("request", (request) => {
    if (request.resourceType() === "document") documents.push(request.url());
  });
  const cards = page.locator("[data-live-event]");
  const types = await cards.evaluateAll((nodes) =>
    nodes.map((node) => (node as HTMLElement).dataset.eventType),
  );
  const filters = page.getByRole("group", { name: "Filter events" });
  expect(types).toContain("orientation");
  expect(types).toContain("patrol");
  await filters
    .getByRole("button", { name: "Orientations", exact: true })
    .click();
  await expect(
    filters.getByRole("button", { name: "Orientations", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("[data-live-event]:visible")).toHaveCount(
    types.filter((type) => type === "orientation").length,
  );
  await expect(page).toHaveURL(/\?type=orientation$/);
  await filters.getByRole("button", { name: "Patrols", exact: true }).click();
  await expect(page.locator("[data-live-event]:visible")).toHaveCount(
    types.filter((type) => type === "patrol").length,
  );
  await page.goBack();
  await expect(
    filters.getByRole("button", { name: "Orientations", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("[data-live-event]:visible")).toHaveCount(
    types.filter((type) => type === "orientation").length,
  );
  expect(documents).toEqual([]);
  await page.reload();
  await expect(page.locator("[data-live-event]:visible")).toHaveCount(
    types.filter((type) => type === "orientation").length,
  );
  await filters
    .getByRole("button", { name: "All events", exact: true })
    .click();
  await expect(page.locator("[data-live-event]:visible")).toHaveCount(
    types.length,
  );
});

test("View as lists actual D1 users and switching to Visitor ends only the current session", async ({
  page,
  request,
  baseURL,
}) => {
  const user = await createLocalAccount(request, baseURL!);
  const independent = await request.get("/api/auth/get-session");
  const independentSession: { session: { id: string } } =
    await independent.json();
  await page.reload();
  const selector = await openLocalAccountSwitcher(page);
  await expect(selector.locator(`option[value="${user.id}"]`)).toContainText(
    user.email,
  );
  await expect(page.locator("[data-account-menu]")).toHaveCount(0);
  await selector.selectOption(user.id);
  await expect(page.locator("[data-account-menu]")).toBeVisible();
  await expect(selector).toHaveValue(user.id);
  const selected = await page.request.get("/api/auth/get-session");
  const selectedSession: { user: { id: string }; session: { id: string } } =
    await selected.json();
  expect(selectedSession.user.id).toBe(user.id);
  expect(selectedSession.session.id).not.toBe(independentSession.session.id);
  await (await openLocalAccountSwitcher(page)).selectOption("");
  await expect(page).toHaveURL(/\/volunteer\/?$/);
  await expect(page.locator("[data-account-menu]")).toHaveCount(0);
  expect(
    await (await page.request.get("/api/auth/get-session")).json(),
  ).toBeNull();
  expect(
    (await (await request.get("/api/auth/get-session")).json()).session.id,
  ).toBe(independentSession.session.id);
});

test("View as can choose an unregistered D1 account without changing it", async ({
  page,
  request,
  baseURL,
}) => {
  const user = await createLocalAccount(request, baseURL!, false);
  await page.reload();
  const selector = await openLocalAccountSwitcher(page);
  await selector.selectOption(user.id);
  await expect(page).toHaveURL(/\/volunteer\/register$/);
  await expect(
    page.getByRole("heading", { name: "Volunteer registration" }),
  ).toBeVisible();
  await expect(page.getByRole("textbox", { name: /^Email/ })).toHaveValue(
    user.email,
  );
  await expect(page.getByLabel("Full or preferred name")).toHaveValue("");
  await expect(selector).toHaveValue(user.id);
});

test("account navigation and profile controls are usable on desktop and mobile", async ({
  page,
  baseURL,
}) => {
  const user = await createLocalAccount(page.request, baseURL!);
  await page.reload();
  for (const width of [1280, 375]) {
    await page.setViewportSize({ width, height: 812 });
    const menu = page.locator("[data-account-menu]");
    await menu.locator("summary").click();
    await expect(menu).toContainText(user.email);
    await menu.getByRole("link", { name: "Profile", exact: true }).click();
    await expect(page).toHaveURL(/\/volunteer\/account$/);
    const name = page.getByLabel("Full or preferred name");
    await expect(name).toHaveValue(user.name);
    await expect(name).toBeEditable();
    await expect(
      page.getByRole("button", { name: "Save profile" }),
    ).toBeEnabled();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
    ).toBe(false);
    await page.getByRole("link", { name: "Events", exact: true }).click();
    await expect(page).toHaveURL(/\/volunteer\/?$/);
  }
  await page.locator("[data-account-menu] summary").click();
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(page).toHaveURL(/\/volunteer\/sign-in$/);
  expect(
    await (await page.request.get("/api/auth/get-session")).json(),
  ).toBeNull();
});

test("local account selection rejects cross-origin writes and unknown users", async ({
  page,
  request,
  baseURL,
}) => {
  const user = await createLocalAccount(request, baseURL!);
  const response = await request.post("/api/auth/dev/switch-user", {
    headers: { origin: "https://evil.example" },
    data: { userId: user.id },
  });
  expect(response.status()).toBe(403);
  const missingOrigin = await request.post("/api/auth/dev/switch-user", {
    data: { userId: user.id },
  });
  expect(missingOrigin.status()).toBe(403);
  const crossSite = await request.get("/api/auth/dev/users", {
    headers: { origin: "https://evil.example" },
  });
  expect(crossSite.status()).toBe(403);
  const unknown = await request.post("/api/auth/dev/switch-user", {
    headers: { origin: baseURL! },
    data: { userId: "not-a-user" },
  });
  expect(unknown.status()).toBe(404);
  expect(
    (await (await request.get("/api/auth/get-session")).json()).user.id,
  ).toBe(user.id);
  await page.reload();
  await openLocalAccountSwitcher(page);
});

test("View as simulates a verified factor without changing the user's real role or enrollment", async ({
  page,
  request,
  baseURL,
}) => {
  const user = await createLocalAccount(request, baseURL!);
  const enabled = await request.post("/api/auth/two-factor/enable", {
    headers: { origin: baseURL! },
    data: { method: "totp" },
  });
  expect(enabled.status()).toBe(200);
  const setup: { totpURI: string } = await enabled.json();
  const verified = await request.post("/api/auth/two-factor/verify-totp", {
    headers: { origin: baseURL! },
    data: {
      code: totpFromSetupKey(
        new URL(setup.totpURI).searchParams.get("secret")!,
      ),
    },
  });
  expect(verified.status()).toBe(200);
  await page.reload();
  const selector = await openLocalAccountSwitcher(page);
  await selector.selectOption(user.id);
  await expect(page.locator("[data-account-menu]")).toBeVisible();
  await expect(selector).toHaveValue(user.id);
  const current = await page.request.get("/api/auth/get-session");
  const session = await current.json();
  expect(session.user.id).toBe(user.id);
  expect(session.user.role).toBe("volunteer");
  expect(session.user.twoFactorEnabled).toBe(true);
  expect(session.session.twoFactorVerified).toBe(true);
  await expect(
    page
      .getByRole("navigation", { name: "Volunteer account" })
      .getByRole("link", { name: "Volunteers", exact: true }),
  ).toHaveCount(0);
});
