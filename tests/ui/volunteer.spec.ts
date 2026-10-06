import { expect, test } from "@playwright/test";
import { createLocalAccount } from "../helpers/local-account";
import { totpFromSetupKey } from "../helpers/totp";

test.beforeEach(async ({ page, baseURL }) => {
  test.skip(
    !baseURL?.startsWith("http://localhost:"),
    "Local D1 development only",
  );
  await page.goto("/volunteer");
});

test("the shared sign-in panel is centered and left-aligned on desktop and mobile", async ({
  page,
}) => {
  for (const width of [1280, 375]) {
    await page.setViewportSize({ width, height: 812 });
    for (const path of ["/volunteer", "/volunteer/sign-in"]) {
      await page.goto(path);
      await expect(
        page.getByRole("link", { name: "Privacy preview", exact: true }),
      ).toHaveCount(0);
      await expect(
        page.getByText(
          "Accounts and events use local D1. No real emails are sent.",
        ),
      ).toHaveCount(0);
      const panel = page.locator(".volunteer-signin-panel");
      await expect(panel).toBeVisible();
      await expect(panel.getByRole("heading")).toHaveCSS("text-align", "left");
      await expect(
        panel.getByText("Sign in to sign up for volunteer events."),
      ).toBeVisible();
      const panelBox = (await panel.boundingBox())!;
      const buttonBox = (await panel
        .getByRole("button", { name: "Continue with Email" })
        .boundingBox())!;
      const inputBox = (await panel
        .getByLabel("Email address", { exact: true })
        .boundingBox())!;
      expect(panelBox.width).toBeLessThanOrEqual(560);
      expect(
        Math.abs(panelBox.x + panelBox.width / 2 - width / 2),
      ).toBeLessThan(1);
      expect(Math.abs(buttonBox.x - inputBox.x)).toBeLessThan(1);
      expect(Math.abs(buttonBox.width - inputBox.width)).toBeLessThan(1);
      await expect(page.locator("header")).toHaveCSS(
        "background-color",
        "rgb(0, 0, 0)",
      );
      await expect(page.locator(".volunteer-portal")).toHaveCSS(
        "background-color",
        "rgb(0, 0, 0)",
      );
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth > innerWidth,
        ),
      ).toBe(false);
    }
  }
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
  await expect(filters.getByRole("combobox")).toHaveCount(0);
  await expect(
    filters.getByRole("button", { name: "Filter events", exact: true }),
  ).toHaveCount(0);
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
  const selector = page.getByLabel("View as", { exact: true });
  await expect(selector).toBeEnabled();
  await expect(selector.locator(`option[value="${user.id}"]`)).toContainText(
    user.email,
  );
  await expect(
    page.getByRole("navigation", { name: "Volunteer account" }),
  ).toHaveCount(0);
  await selector.selectOption(user.id);
  await expect(
    page.getByRole("navigation", { name: "Volunteer account" }),
  ).toBeVisible();
  await expect(selector).toHaveValue(user.id);
  const selected = await page.request.get("/api/auth/get-session");
  const selectedSession: { user: { id: string }; session: { id: string } } =
    await selected.json();
  expect(selectedSession.user.id).toBe(user.id);
  expect(selectedSession.session.id).not.toBe(independentSession.session.id);
  await selector.selectOption("");
  await expect(page).toHaveURL(/\/volunteer\/?$/);
  await expect(
    page.getByRole("navigation", { name: "Volunteer account" }),
  ).toHaveCount(0);
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
  const selector = page.getByLabel("View as", { exact: true });
  await expect(selector).toBeEnabled();
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
  await expect(
    page.locator("[data-account-profile] .account-notice"),
  ).toHaveCount(0);
  await expect(
    page.getByRole("link", { name: "Read the privacy notice" }),
  ).toHaveCount(0);
});

for (const width of [1280, 375]) {
  test(`account edits persist in D1 and use the shared UI at ${width}px`, async ({
    page,
    request,
    baseURL,
  }) => {
    const user = await createLocalAccount(request, baseURL!);
    await page.setViewportSize({ width, height: 812 });
    await page.reload();
    const selector = page.getByLabel("View as", { exact: true });
    await expect(selector).toBeEnabled();
    await selector.selectOption(user.id);
    await page.getByRole("link", { name: user.name, exact: true }).click();
    await expect(page).toHaveURL(/\/volunteer\/account$/);
    const access = page.locator(".volunteer-access");
    await expect(access).toHaveCSS("background-color", "rgb(22, 33, 74)");
    await expect(
      access.getByRole("heading", {
        name: "Start with an orientation",
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      access.getByRole("link", { name: "Find an event", exact: true }),
    ).toHaveAttribute("href", "/volunteer");
    const profilePanel = page.locator(".volunteer-panel").filter({
      has: page.getByRole("heading", { name: "Your profile", exact: true }),
    });
    await expect(profilePanel).toHaveCSS("background-color", "rgb(12, 13, 16)");
    await expect(profilePanel).toHaveCSS("border-radius", "10px");
    await expect(profilePanel.locator("input[readonly]")).toHaveCSS(
      "background-color",
      "rgb(23, 26, 32)",
    );
    await expect(profilePanel.locator('input[name="name"]')).toHaveCSS(
      "background-color",
      "rgb(5, 6, 8)",
    );
    await expect(
      page.getByRole("heading", { name: "Account settings", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Community", exact: true }),
    ).toBeVisible();
    const nav = page.getByRole("navigation", { name: "Volunteer account" });
    for (const link of await nav.getByRole("link").all()) {
      await expect(link).toHaveCSS("text-decoration-line", "none");
      await expect(link).toHaveCSS("box-shadow", "none");
    }
    const columnCount = await profilePanel
      .locator(".volunteer-fields")
      .evaluate(
        (element) =>
          getComputedStyle(element).gridTemplateColumns.split(" ").length,
      );
    expect(columnCount).toBe(width > 640 ? 2 : 1);
    await expect(
      page.locator("[data-account-profile] .account-notice"),
    ).toHaveCount(0);
    await expect(
      page.getByRole("link", { name: "Read the privacy notice" }),
    ).toHaveCount(0);
    const updatedName = `Updated ${crypto.randomUUID().slice(0, 8)}`;
    await page.getByLabel("Full or preferred name").fill(updatedName);
    await page.getByLabel("Pronouns").fill("she/her");
    await page.getByRole("button", { name: "Save profile" }).click();
    await expect(
      page.locator("[data-account-profile] [data-form-message]"),
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: updatedName, exact: true }),
    ).toBeVisible();
    await page.reload();
    await expect(page.getByLabel("Full or preferred name")).toHaveValue(
      updatedName,
    );
    await expect(page.getByLabel("Pronouns")).toHaveValue("she/her");
    expect(
      await page.evaluate(() =>
        localStorage.getItem("aho-local-volunteer-demo"),
      ),
    ).toBeNull();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
    ).toBe(false);
    await expect(page.locator(".volunteer-portal")).toHaveCSS(
      "background-color",
      "rgb(0, 0, 0)",
    );
    if (width === 1280)
      await page
        .getByRole("link", { name: "Create an account", exact: true })
        .click();
    else
      await page.getByRole("button", { name: "Sign out", exact: true }).click();
    await expect(page).toHaveURL(/\/volunteer\/sign-in$/);
    await expect(selector).toHaveValue("");
  });
}

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
  await expect(page.getByLabel("View as", { exact: true })).toBeEnabled();
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
  const selector = page.getByLabel("View as", { exact: true });
  await expect(selector).toBeEnabled();
  await selector.selectOption(user.id);
  await expect(
    page.getByRole("navigation", { name: "Volunteer account" }),
  ).toBeVisible();
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
