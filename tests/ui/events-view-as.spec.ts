import { expect, test } from "@playwright/test";

test("organizers preview events as a volunteer type or a volunteer, read-only", async ({
  page,
  baseURL,
}) => {
  test.skip(!baseURL?.startsWith("http://localhost:"), "Local D1 only");
  const switched = await page.request.post("/api/v1/auth/dev/switch-user", {
    headers: { origin: baseURL! },
    data: { userId: "local-fixture-user-robin" },
  });
  expect(switched.ok(), await switched.text()).toBe(true);
  await page.goto("/events");
  const viewAs = page.getByRole("button", { name: "View as" });
  await viewAs.click();
  const menu = page.locator('[data-filter-menu="view-as"]');
  await expect(menu).toBeVisible();
  await menu.getByRole("link", { name: "New volunteer", exact: true }).click();

  await expect(page).toHaveURL(/\/events\?viewAs=new$/);
  await expect(page.locator("[data-view-as-notice]")).toContainText(
    "Viewing events as New volunteer",
  );
  // New volunteers only see orientation events, and nothing can be submitted.
  const cards = page.locator("[data-event-list] [data-live-event]");
  expect(await cards.count()).toBeGreaterThan(0);
  for (const card of await cards.all())
    await expect(card).toHaveAttribute("data-includes-orientation", "true");
  await expect(page.locator("[data-live-signup]")).toHaveCount(0);
  await expect(
    page.locator("[data-show-dialog^='event-editor'], [data-bulk-select-mode]"),
  ).toHaveCount(0);
  for (const button of await page.locator(".volunteer-actions button").all())
    await expect(button).toBeDisabled();
  // Polling compares against the previewed viewer's version.
  const matches = await page.evaluate(async () => {
    const browser = document.querySelector<HTMLElement>(
      "[data-event-browser]",
    )!;
    const url = new URL("/api/v1/events/version", location.origin);
    url.searchParams.set("viewAs", browser.dataset.eventViewAs!);
    const { version }: { version?: string } = await (await fetch(url)).json();
    return version === browser.dataset.eventVersion;
  });
  expect(matches).toBe(true);

  await page.getByRole("button", { name: "View as: New volunteer" }).click();
  await menu.getByRole("searchbox", { name: "Search volunteers" }).fill("zzz");
  await expect(menu.locator("[data-filter-empty]")).toBeVisible();
  await menu.getByRole("searchbox", { name: "Search volunteers" }).fill("");
  const person = menu.locator(".view-as-people a").first();
  const name = (await person.textContent())!.trim();
  await person.click();
  await expect(page).toHaveURL(/viewAs=person%3A/);
  await expect(page.locator("[data-view-as-notice]")).toContainText(
    `Viewing events as ${name}`,
  );
  await expect(page.locator("[data-live-signup]")).toHaveCount(0);

  await page.getByRole("link", { name: "Back to managing events" }).click();
  await expect(page).toHaveURL(/\/events$/);
  await expect(page.getByRole("button", { name: "Create" })).toBeVisible();

  expect(
    (await page.request.get("/events?viewAs=person:missing")).status(),
  ).toBe(404);
});
