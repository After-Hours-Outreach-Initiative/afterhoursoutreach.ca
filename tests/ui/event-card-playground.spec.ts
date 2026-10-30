import { expect, test } from "@playwright/test";

test("event card playground shows varied real rosters, resizes, and simulates registrations without APIs", async ({
  page,
  baseURL,
}) => {
  test.setTimeout(60_000);
  test.skip(
    !baseURL?.startsWith("http://"),
    "The playground exists only in local development.",
  );
  const origin = new URL(baseURL!).origin;
  const forbidden: string[] = [];
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== origin || url.pathname.startsWith("/api/v1")) {
      forbidden.push(url.href);
      await route.abort();
    } else {
      await route.continue();
    }
  });
  await page.goto("/dev/ui/event-card");
  const previewResponse = await page.request.get(
    "/dev/ui/event-card/preview?scenario=full",
  );
  expect(previewResponse.headers()["content-security-policy"]).toBe(
    "form-action 'none'",
  );
  await expect(
    page.getByRole("link", { name: "Event card", exact: true }),
  ).toHaveAttribute("aria-current", "page");
  await expect(page.locator("[data-ui-event-frame]")).toHaveCount(8);
  const full = page.frameLocator('[data-ui-event-frame="full"]');
  const card = full.locator(".volunteer-event-card");
  await expect(card).toContainText("8 of 8 spots taken");
  await expect(card).toContainText("This event is full.");
  await expect(
    card.getByRole("button", { name: "Register", exact: true }),
  ).toHaveCount(0);
  const avatars = card.locator(".event-avatar-row");
  await expect(avatars.locator(".attendee-medic")).toHaveCount(2);
  await expect(avatars.locator(".attendee-outreach-volunteer")).toHaveCount(2);
  await expect(avatars.locator(".attendee-new-volunteer")).toHaveCount(4);
  await page.getByRole("checkbox", { name: "Expand all rosters" }).check();
  await expect(card.locator("details")).toHaveAttribute("open", "");
  await expect(card.getByRole("row")).toHaveCount(9);
  await expect
    .poll(async () =>
      Number(
        await page
          .locator('[data-ui-event-frame="full"]')
          .getAttribute("height"),
      ),
    )
    .toBeGreaterThan(500);

  const width = page.getByRole("combobox", { name: "Preview width" });
  await width.selectOption("320");
  await expect.poll(() => card.evaluate(() => window.innerWidth)).toBe(320);
  expect(
    await card.evaluate(
      (element) => element.scrollWidth <= element.clientWidth,
    ),
  ).toBe(true);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await width.selectOption("768");
  await expect.poll(() => card.evaluate(() => window.innerWidth)).toBe(768);
  expect(
    await card.evaluate(
      (element) => element.scrollWidth <= element.clientWidth,
    ),
  ).toBe(true);

  const mixed = page.frameLocator('[data-ui-event-frame="mixed"]');
  await mixed.getByRole("button", { name: "Register", exact: true }).click();
  await expect(mixed.locator("[data-event-availability]")).toContainText(
    "Registered · 7 of 8 spots taken",
  );
  await expect(
    mixed.getByRole("rowheader", { name: "Morgan P." }),
  ).toBeVisible();
  await mixed.getByRole("button", { name: "Unregister", exact: true }).click();
  await expect(mixed.locator("[data-event-availability]")).toHaveText(
    "6 of 8 spots taken",
  );

  const registered = page.frameLocator('[data-ui-event-frame="registered"]');
  await registered
    .getByRole("button", { name: "Unregister", exact: true })
    .click();
  await expect(
    registered.getByRole("button", { name: "Register", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Reset previews" }).click();
  await expect(width).toHaveValue("fit");
  await expect(
    page.getByRole("checkbox", { name: "Expand all rosters" }),
  ).not.toBeChecked();
  await expect(
    registered.getByRole("button", { name: "Unregister", exact: true }),
  ).toBeVisible();
  await expect(card.locator("details")).not.toHaveAttribute("open", "");
  await page.setViewportSize({ width: 375, height: 812 });
  await expect
    .poll(() => card.evaluate(() => window.innerWidth))
    .toBeLessThanOrEqual(375);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  expect(forbidden).toEqual([]);
});
