import { expect, test } from "@playwright/test";

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
