import { expect, test } from "@playwright/test";
import { openLocalAccountSwitcher } from "../helpers/local-account";

test("DEV panel fills the viewport and adapts its account grids", async ({
  page,
  baseURL,
}) => {
  test.skip(
    !baseURL?.startsWith("http://localhost:"),
    "Requires local development.",
  );
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/dev/ui");
  await openLocalAccountSwitcher(page);
  const panel = page.getByRole("dialog", { name: "DEV panel", exact: true });
  const accounts = panel.locator(
    '[data-account-category="application"] .account-profile-buttons',
  );

  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 2560, height: 1440 },
    { width: 375, height: 812 },
    { width: 320, height: 568 },
  ]) {
    await page.setViewportSize(viewport);
    const bounds = (await panel.boundingBox())!;
    expect(bounds.width).toBeCloseTo(viewport.width - 32, 0);
    expect(bounds.height).toBeCloseTo(viewport.height - 32, 0);
    await expect(panel).toBeInViewport({ ratio: 1 });
    await expect(panel.locator(".dialog-header")).toBeInViewport({ ratio: 1 });
    await expect(panel.locator(".dialog-footer")).toBeInViewport({ ratio: 1 });
    expect(
      await panel.evaluate(
        (element) => element.scrollWidth > element.clientWidth,
      ),
    ).toBe(false);
    const columns = await accounts.evaluate(
      (element) =>
        getComputedStyle(element).gridTemplateColumns.split(" ").length,
    );
    if (viewport.width >= 1440) expect(columns).toBeGreaterThan(2);
    else expect(columns).toBe(1);
  }
});

for (const path of [
  "/",
  "/about",
  "/donate",
  "/privacy",
  "/missing-dev-panel-test-page",
  "/volunteer/sign-in",
  "/dev/ui",
  "/dev/ui/organizer-profile",
  "/dev/ui/discord?scenario=connected",
]) {
  test(`DEV panel works on ${path}`, async ({ page, baseURL }) => {
    test.skip(
      !baseURL?.startsWith("http://localhost:"),
      "Requires local development.",
    );
    const accountRequests: string[] = [];
    page.on("request", (request) => {
      if (new URL(request.url()).pathname.startsWith("/api/v1/auth/dev/"))
        accountRequests.push(request.url());
    });
    await page.goto(path, { waitUntil: "domcontentloaded" });
    const trigger = page.getByRole("button", {
      name: "DEV panel",
      exact: true,
    });
    const panel = page.getByRole("dialog", { name: "DEV panel", exact: true });
    await expect(trigger).toHaveCount(1);
    await expect(trigger).toBeVisible();
    expect(accountRequests).toEqual([]);

    await trigger.focus();
    await page.keyboard.press("Alt+KeyZ");
    await expect(panel).toBeVisible();
    await expect(trigger).toHaveAttribute("aria-expanded", "true");
    await expect(
      panel.getByRole("button", { name: "Visitor", exact: true }),
    ).toBeEnabled();
    await expect(panel.locator("[data-view-as]")).toHaveAttribute(
      "aria-busy",
      "false",
    );
    expect(accountRequests.length).toBeGreaterThan(0);
    await panel.getByRole("button", { name: "Close DEV panel" }).click();
    await expect(panel).toBeHidden();
    await expect(trigger).toHaveAttribute("aria-expanded", "false");
    await expect(trigger).toBeFocused();

    const requestsAfterOpening = accountRequests.length;
    await trigger.click();
    await expect(panel).toBeVisible();
    await page.keyboard.press("Alt+KeyZ");
    await expect(panel).toBeHidden();
    expect(accountRequests).toHaveLength(requestsAfterOpening);
  });
}
