import { expect, test, type Locator } from "@playwright/test";

test("wide screens show filters beside the list and apply each change at once", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/dev/ui/applications/preview?scenario=mixed&latency=0");
  const rows = page.locator("[data-volunteer-results] [data-volunteer-row]");
  const total = await rows.count();
  const panel = page.locator("[data-filter-panel]");
  const results = page.locator("[data-volunteer-results]");
  await expect(panel).toBeVisible();
  await expect(page.getByRole("button", { name: /^Filter/ })).toBeHidden();
  const panelBox = (await panel.boundingBox())!;
  const resultsBox = (await results.boundingBox())!;
  expect(panelBox.x + panelBox.width).toBeLessThan(resultsBox.x);

  await panel.getByRole("checkbox", { name: /^Rejected/ }).check();
  await expect(page).toHaveURL(/approval=rejected/);
  expect(await rows.count()).toBeLessThan(total);
  for (const status of await rows
    .locator(".application-status-text")
    .allTextContents())
    expect(status.trim()).toBe("Rejected");

  await panel.getByRole("link", { name: "Clear filters" }).click();
  await expect(page).not.toHaveURL(/approval=/);
  await expect(rows).toHaveCount(total);
  await expect(panel.getByRole("link", { name: "Clear filters" })).toBeHidden();
});

test("small screens open the same filters in a sheet that applies when it closes", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/dev/ui/applications/preview?scenario=mixed&latency=0");
  const rows = page.locator("[data-volunteer-results] [data-volunteer-row]");
  const total = await rows.count();
  const panel = page.locator("[data-filter-panel]");
  const trigger = page.getByRole("button", { name: /^Filter/ });
  await expect(panel).toBeHidden();

  await trigger.click();
  await expect(panel).toBeVisible();
  await panel.getByRole("checkbox", { name: /^Rejected/ }).check();
  // Choices wait in the open sheet.
  await expect(page).not.toHaveURL(/approval=/);
  await expect(rows).toHaveCount(total);
  await page.keyboard.press("Escape");
  await expect(panel).toBeHidden();
  await expect(page).toHaveURL(/approval=rejected/);
  await expect(trigger).toBeFocused();
  await expect(trigger.locator("[data-filter-panel-count]")).toHaveText(
    /^1\s*active$/,
  );
  expect(await rows.count()).toBeLessThan(total);

  // Sorting is its own menu beside the filter button.
  const sortTrigger = page.getByRole("button", { name: /^Sort:/ });
  const triggerBox = (await trigger.boundingBox())!;
  const sortBox = (await sortTrigger.boundingBox())!;
  expect(Math.round(sortBox.y)).toBe(Math.round(triggerBox.y));
  expect(Math.abs(sortBox.width - triggerBox.width)).toBeLessThan(2);
  await sortTrigger.click();
  await page
    .locator('[data-filter-menu="sort"]')
    .getByRole("radio", { name: "Name" })
    .check();
  await expect(page).toHaveURL(/sort=name/);
  await expect(page).toHaveURL(/approval=rejected/);
  await page.keyboard.press("Escape");

  // Widening the screen turns the open sheet back into the sidebar.
  await trigger.click();
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(page.locator("[data-filter-panel][open]")).toHaveCount(0);
  await expect(panel).toBeVisible();
});

test("the role sort order can be rearranged by keyboard and by dragging", async ({
  page,
}) => {
  // Keep the whole menu in view so the drag starts on the visible item.
  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.goto("/dev/ui/volunteers/preview?scenario=mixed&latency=0");
  const firstPerson = () =>
    page
      .locator("[data-volunteer-results] [data-volunteer-row]")
      .first()
      .evaluate((row: HTMLElement) => {
        const person = JSON.parse(row.dataset.directoryPerson!);
        return person.role === "organizer" ? "organizer" : person.category;
      });
  // The default role order puts new volunteers first and organizers last.
  expect(await firstPerson()).toBe("new-volunteer");
  await page.getByRole("button", { name: "Sort: Role" }).click();
  const panel = page.locator('[data-filter-menu="sort"]');
  // The menu stays hidden until it is placed under its trigger.
  await expect(panel).toBeVisible();
  const items = panel.locator("[data-sort-order-item]");
  await expect(items).toHaveText([
    "New volunteer",
    "Outreach Volunteer",
    "Medic",
    "Organizer",
  ]);
  const organizer = panel.locator('[data-sort-order-item="organizer"]');
  await organizer.focus();
  await page.keyboard.press("ArrowUp");
  await expect(organizer).toBeFocused();
  await expect(items).toHaveText([
    "New volunteer",
    "Outreach Volunteer",
    "Organizer",
    "Medic",
  ]);
  await expect(page).toHaveURL(/order=new%2Cvolunteer%2Corganizer%2Cmedic/);

  const outreach = panel.locator('[data-sort-order-item="volunteer"]');
  const from = (await outreach.boundingBox())!;
  const to = (await items.first().boundingBox())!;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + from.width / 2, to.y + 2, { steps: 8 });
  await page.mouse.up();
  await expect(items).toHaveText([
    "Outreach Volunteer",
    "New volunteer",
    "Organizer",
    "Medic",
  ]);
  await expect(page).toHaveURL(/order=volunteer%2Cnew%2Corganizer%2Cmedic/);
  expect(await firstPerson()).toBe("outreach-volunteer");

  // Sorting by name hides the role order until Role is chosen again.
  await panel.getByRole("radio", { name: "Name" }).check();
  await expect(panel.locator('[data-sort-order="role"]')).toBeHidden();
  await panel.getByRole("radio", { name: "Role" }).check();
  await expect(panel.locator('[data-sort-order="role"]')).toBeVisible();

  // A changed order can be reset to the default.
  const roleOrder = panel.locator('[data-sort-order="role"]');
  const reset = roleOrder.getByRole("button", { name: "Reset" });
  await expect(reset).toBeVisible();
  await reset.click();
  await expect(items).toHaveText([
    "New volunteer",
    "Outreach Volunteer",
    "Medic",
    "Organizer",
  ]);
  await expect(page).not.toHaveURL(/order=/);
  await expect(reset).toBeHidden();
});

test("the status sort order can be rearranged and reset", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.goto("/dev/ui/applications/preview?scenario=mixed&latency=0");
  const firstStatus = () =>
    page
      .locator("[data-volunteer-results] .application-status-text")
      .first()
      .textContent();
  expect((await firstStatus())?.trim()).toBe("Ready for review");
  await page.getByRole("button", { name: "Sort: Status" }).click();
  const menu = page.locator('[data-filter-menu="sort"]');
  await expect(menu).toBeVisible();
  const statusOrder = menu.locator('[data-sort-order="progress"]');
  const items = statusOrder.locator("[data-sort-order-item]");
  await expect(items).toHaveText([
    "Ready for review",
    "In Progress",
    "Rejected",
    "Approved",
  ]);
  await expect(menu.locator('[data-sort-order="role"]')).toBeHidden();
  const reset = statusOrder.getByRole("button", { name: "Reset" });
  await expect(reset).toBeHidden();

  const rejected = statusOrder.locator('[data-sort-order-item="rejected"]');
  await rejected.focus();
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowUp");
  await expect(items).toHaveText([
    "Rejected",
    "Ready for review",
    "In Progress",
    "Approved",
  ]);
  await expect(page).toHaveURL(
    /statusOrder=rejected%2Cawaiting%2Cin-progress%2Capproved/,
  );
  expect((await firstStatus())?.trim()).toBe("Rejected");

  await reset.click();
  await expect(page).not.toHaveURL(/statusOrder=/);
  expect((await firstStatus())?.trim()).toBe("Ready for review");
  await expect(reset).toBeHidden();

  // Sorting by role shows the role order instead.
  await menu.getByRole("radio", { name: "Role" }).check();
  await expect(statusOrder).toBeHidden();
  await expect(menu.locator('[data-sort-order="role"]')).toBeVisible();

  // A changed sort can be reset to the default.
  const sortReset = menu.locator("[data-sort-reset]");
  await menu.getByRole("radio", { name: "Descending" }).check();
  await expect(page).toHaveURL(/sort=role/);
  await expect(page).toHaveURL(/direction=desc/);
  await sortReset.click();
  await expect(page).not.toHaveURL(/sort=|direction=/);
  await expect(menu.getByRole("radio", { name: "Status" })).toBeChecked();
  await expect(menu.getByRole("radio", { name: "Ascending" })).toBeChecked();
  await expect(sortReset).toBeHidden();
  await expect(statusOrder).toBeVisible();
});

test("the search clear button appears with text and empties the search", async ({
  page,
}) => {
  await page.goto("/dev/ui/volunteers/preview?scenario=mixed&latency=0");
  const search = page.locator("[data-volunteer-search]");
  const clear = page.getByRole("button", { name: "Clear search" }).first();
  const rows = page.locator("[data-volunteer-results] [data-volunteer-row]");
  const total = await rows.count();
  await expect(clear).toBeHidden();
  await search.fill("sam");
  await expect(page).toHaveURL(/q=sam/);
  await clear.click();
  await expect(search).toHaveValue("");
  await expect(search).toBeFocused();
  await expect(clear).toBeHidden();
  await expect(page).not.toHaveURL(/q=/);
  await expect(rows).toHaveCount(total);
});

test("an empty result offers to reset search, filters and sort", async ({
  page,
}) => {
  await page.goto(
    "/dev/ui/volunteers/preview?scenario=mixed&latency=0&role=organizer&sort=name&direction=desc",
  );
  const rows = page.locator("[data-volunteer-results] [data-volunteer-row]");
  const reset = page.getByRole("link", {
    name: "Reset search, filters and sort",
  });
  await page.locator("[data-volunteer-search]").fill("no matching person");
  await expect(rows).toHaveCount(0);
  await reset.click();
  await expect(page).not.toHaveURL(/role=|sort=|direction=|q=/);
  await expect(page.locator("[data-volunteer-search]")).toHaveValue("");
  await expect(rows).toHaveCount(8);
  await expect(page.locator("[data-volunteer-empty]")).toBeHidden();
});

test("the tap after swiping a sheet away still works", async ({
  browser,
  browserName,
}) => {
  test.skip(browserName !== "chromium", "Touch input needs Chromium's CDP.");
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
  });
  const page = await context.newPage();
  await page.goto("/dev/ui/applications/preview?scenario=mixed&latency=0");
  const cdp = await context.newCDPSession(page);
  const touch = (type: string, x = 0, y = 0) =>
    cdp.send("Input.dispatchTouchEvent", {
      type,
      touchPoints: type === "touchEnd" ? [] : [{ x, y }],
    });
  const tap = async (target: Locator) => {
    const box = (await target.boundingBox())!;
    await touch("touchStart", box.x + 10, box.y + 10);
    await touch("touchEnd");
  };

  for (const [trigger, sheet] of [
    [
      page.getByRole("button", { name: /^Filter/ }),
      page.locator("[data-filter-panel]"),
    ],
    [
      page.getByRole("button", { name: /^Sort:/ }),
      page.locator('[data-filter-menu="sort"]'),
    ],
  ]) {
    await tap(trigger);
    await expect(sheet).toBeVisible();
    await sheet.evaluate((element) =>
      Promise.all(
        element.getAnimations().map((animation) => animation.finished),
      ),
    );
    // A quick flick down the sheet's header.
    const handle = (await sheet.locator("[data-sheet-handle]").boundingBox())!;
    const x = handle.x + 40;
    await touch("touchStart", x, handle.y + 10);
    for (let step = 1; step <= 10; step++) {
      await touch("touchMove", x, handle.y + 10 + step * 50);
      await page.waitForTimeout(16);
    }
    await touch("touchEnd");
    await expect(sheet).toBeHidden();

    await tap(trigger);
    await expect(sheet).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(sheet).toBeHidden();
  }
  await context.close();
});
