import { expect, test } from "@playwright/test";

for (const kind of ["applications", "volunteers"]) {
  test(`${kind} instantly search, filter and sort all 500 cached entries without network requests`, async ({
    page,
    context,
  }) => {
    await page.goto(
      `/dev/ui/${kind}/preview?scenario=large&latency=0&q=sample+500&offset=50`,
    );
    const rows = page.locator("[data-volunteer-results] tbody tr");
    const search = page.locator("[data-volunteer-search]");
    await expect(rows).toHaveCount(1);
    await expect(rows).toContainText("sample 500");
    await expect(
      page.getByRole("button", { name: "Search", exact: true }),
    ).toBeHidden();
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
        return document.querySelectorAll("[data-volunteer-results] tbody tr")
          .length;
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
      const ready = page.getByRole("button", {
        name: "Ready for review 250",
        exact: true,
      });
      await ready.click();
      await expect(ready).toBeFocused();
      await expect(rows).toHaveCount(250);
      await search.fill("sample 001");
      await expect(rows).toHaveCount(0);
      await expect(page.locator("[data-all-applicants-count]")).toHaveText("1");
      await expect(page.locator("[data-awaiting-approval-count]")).toHaveText(
        "0",
      );
      await page.getByRole("button", { name: "All 1", exact: true }).click();
      await expect(rows).toHaveCount(1);
      await search.fill("");
    }
    const sort = page.locator('[data-volunteer-sort="name"]');
    await sort.focus();
    await page.keyboard.press("Enter");
    await expect(sort).toBeFocused();
    await expect(sort.locator("..")).toHaveAttribute("aria-sort", "ascending");
    const ascending = await rows
      .locator("[data-volunteer-profile-link]")
      .allTextContents();
    await sort.click();
    await expect(sort.locator("..")).toHaveAttribute("aria-sort", "descending");
    expect(
      await rows.locator("[data-volunteer-profile-link]").allTextContents(),
    ).toEqual(ascending.toReversed());
    await page.goBack();
    await expect(sort.locator("..")).toHaveAttribute("aria-sort", "ascending");
    await page.goForward();
    await expect(sort.locator("..")).toHaveAttribute("aria-sort", "descending");
    expect(requests).toEqual([]);
  });
}

test("background refresh preserves newer local search and sorting; failure leaves the cache usable", async ({
  page,
}) => {
  await page.goto("/dev/ui/applications/preview?scenario=mixed&latency=0");
  const rows = page.locator("[data-volunteer-results] tbody tr");
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
  const sort = page.locator('[data-volunteer-sort="name"]');
  await sort.click();
  release();
  await expect(rows).toHaveCount(1);
  await expect(rows).toContainText("sample 500");
  await expect(page.locator("[data-volunteer-search]")).toHaveValue(
    "sample 500",
  );
  await expect(sort.locator("..")).toHaveAttribute("aria-sort", "ascending");
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
  await expect(page.locator("[data-volunteer-results] tbody tr")).toHaveCount(
    8,
  );
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
