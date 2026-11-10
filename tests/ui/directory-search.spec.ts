import { expect, test } from "@playwright/test";
import { expectDirectorySort, sortDirectory } from "../helpers/directory-sort";

for (const kind of ["applications", "volunteers"]) {
  test(`${kind} instantly search, filter and sort all 500 cached entries without network requests`, async ({
    page,
    context,
  }) => {
    await page.goto(
      `/dev/ui/${kind}/preview?scenario=large&latency=0&q=sample+500&offset=50`,
    );
    const rows = page.locator("[data-volunteer-results] [data-volunteer-row]");
    const search = page.locator("[data-volunteer-search]");
    await expect(rows).toHaveCount(1);
    await expect(rows).toContainText("sample 500");
    await expect(
      page.getByRole("link", {
        name: /^(Next|Previous) (applications|volunteers)$/,
      }),
    ).toHaveCount(0);
    expect(new URL(page.url()).searchParams.has("offset")).toBe(false);
    await page.evaluate(() => document.fonts.ready);
    const requests: string[] = [];
    page.on("request", (request) => {
      if (["document", "fetch", "xhr"].includes(request.resourceType()))
        requests.push(request.url());
    });
    await context.setOffline(true);

    // Check immediately after dispatch: no debounce, animation frame or server.
    expect(
      await search.evaluate((input: HTMLInputElement) => {
        input.value = "";
        input.dispatchEvent(new Event("input", { bubbles: true }));
        return document.querySelectorAll(
          "[data-volunteer-results] [data-volunteer-row]",
        ).length;
      }),
    ).toBe(500);
    await search.fill("sample 001");
    await expect(search).toBeFocused();
    await expect(rows).toHaveCount(1);
    await expect(rows).toContainText("sample 001");
    await search.fill("no matching person");
    await expect(rows).toHaveCount(0);
    await expect(page.locator("[data-volunteer-empty]")).toBeVisible();
    await search.fill("");
    await expect(rows).toHaveCount(500);

    if (kind === "applications") {
      const status = page.locator('[data-filter-menu="approval"]');
      await page.getByRole("button", { name: /^Status/ }).click();
      await expect(status.locator('[data-filter-count="awaiting"]')).toHaveText(
        "250",
      );
      await status.getByRole("checkbox", { name: /^Ready for review/ }).check();
      await status.getByRole("button", { name: "Apply" }).click();
      await expect(rows).toHaveCount(250);
      await search.fill("sample 001");
      await expect(rows).toHaveCount(0);
      await expect(status.locator('[data-filter-count="awaiting"]')).toHaveText(
        "0",
      );
      await page.getByRole("link", { name: "Clear filters" }).click();
      await expect(rows).toHaveCount(1);
      await search.fill("");
    }
    await sortDirectory(page, "name", "asc");
    await expectDirectorySort(page, "name", "asc");
    const ascending = await rows
      .locator("[data-volunteer-profile-link]")
      .allTextContents();
    await sortDirectory(page, "name", "desc");
    await expectDirectorySort(page, "name", "desc");
    expect(
      await rows.locator("[data-volunteer-profile-link]").allTextContents(),
    ).toEqual(ascending.toReversed());
    await page.goBack();
    await expectDirectorySort(page, "name", "asc");
    await page.goForward();
    await expectDirectorySort(page, "name", "desc");
    expect(requests).toEqual([]);
  });
}

test("background refresh preserves newer local search and sorting; failure leaves the cache usable", async ({
  page,
}) => {
  await page.goto("/dev/ui/applications/preview?scenario=mixed&latency=0");
  const rows = page.locator("[data-volunteer-results] [data-volunteer-row]");
  await expect(rows).toHaveCount(8);
  const updated = await page.request.get(
    "/dev/ui/applications/preview?scenario=large&latency=0",
  );
  const updatedHtml = await updated.text();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let refreshes = 0;
  await page.route("**/dev/ui/applications/preview?**", async (route) => {
    refreshes++;
    if (refreshes === 1) {
      await gate;
      await route.fulfill({
        status: 200,
        contentType: "text/html",
        body: updatedHtml,
      });
    } else await route.fulfill({ status: 503, body: "Unavailable" });
  });
  await page.evaluate(() =>
    document.dispatchEvent(new Event("visibilitychange")),
  );
  await expect(page.locator("[data-volunteer-results]")).toHaveAttribute(
    "aria-busy",
    "true",
  );
  await page.locator("[data-volunteer-search]").fill("sample 500");
  await expect(rows).toHaveCount(0);
  await sortDirectory(page, "name", "asc");
  release();
  await expect(rows).toHaveCount(1);
  await expect(rows).toContainText("sample 500");
  await expect(page.locator("[data-volunteer-search]")).toHaveValue(
    "sample 500",
  );
  await expectDirectorySort(page, "name", "asc");
  await expect(page).toHaveURL(/q=sample\+500&sort=name$/);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.locator("[data-volunteer-search-error]")).toBeVisible();
  await expect(rows).toHaveCount(1);
  await page.locator("[data-volunteer-search]").fill("sample 499");
  await expect(rows).toHaveCount(1);
  await expect(rows).toContainText("sample 499");
  expect(refreshes).toBe(2);
});

test("the browser search index contains directory fields only, not review reasons or private answers", async ({
  page,
}) => {
  await page.goto("/dev/ui/applications/preview?scenario=mixed&latency=0");
  await expect(
    page.locator("[data-volunteer-results] [data-volunteer-row]"),
  ).toHaveCount(8);
  const metadata = await page
    .locator("[data-volunteer-row]")
    .first()
    .getAttribute("data-directory-person");
  expect(Object.keys(JSON.parse(metadata!)).sort()).toEqual([
    "applicationCompletedAt",
    "category",
    "id",
    "medicMark",
    "name",
    "role",
    "searchName",
    "status",
  ]);
  expect(await page.content()).not.toContain(
    "Fictional application review decision.",
  );
  // Full surname matching must survive abbreviated display names and a URL
  // whose initial server results excluded this person.
  await page.goto(
    "/dev/ui/applications/preview?scenario=mixed&latency=0&q=Alex",
  );
  await expect(page.locator("[data-volunteer-row]")).toHaveCount(1);
  await page.locator("[data-volunteer-search]").fill("O’NEILL");
  await expect(page.locator("[data-volunteer-row]")).toHaveCount(1);
  await expect(page.locator("[data-volunteer-profile-link]")).toHaveText(
    "Casey O.",
  );
});
