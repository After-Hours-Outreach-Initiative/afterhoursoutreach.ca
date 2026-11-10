import { expect, test, type Page } from "@playwright/test";

/** Record the menu's paint state on each frame from the moment it opens. */
async function recordFrames(page: Page, selector: string) {
  await page.evaluate((selector) => {
    const menu = document.querySelector<HTMLElement>(selector)!;
    const frames: { open: boolean; visible: boolean; top: number }[] = [];
    (window as unknown as { menuFrames: typeof frames }).menuFrames = frames;
    const tick = () => {
      frames.push({
        open: menu.matches(":popover-open"),
        visible: getComputedStyle(menu).visibility === "visible",
        top: menu.getBoundingClientRect().top,
      });
      if (frames.length < 12) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, selector);
}

test("status and role filters open in place, apply on close, and scroll with the page", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 600 });
  await page.goto("/dev/ui/applications/preview?scenario=mixed&latency=0");
  const rows = page.locator("[data-volunteer-results] [data-volunteer-row]");
  const total = await rows.count();
  const trigger = page.getByRole("button", { name: /^Status/ });
  const menu = page.locator('[data-filter-menu="approval"]');
  await recordFrames(page, '[data-filter-menu="approval"]');
  await trigger.click();
  await expect(menu).toBeVisible();
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
  const triggerBox = (await trigger.boundingBox())!;
  const frames = await page.evaluate(
    () =>
      (
        window as unknown as {
          menuFrames: { open: boolean; visible: boolean; top: number }[];
        }
      ).menuFrames,
  );
  // An open menu is never painted away from its trigger, even on first open.
  for (const frame of frames.filter(({ open, visible }) => open && visible))
    expect(frame.top).toBeGreaterThan(triggerBox.y + triggerBox.height);

  await page.mouse.wheel(0, 120);
  await expect
    .poll(async () => {
      const menuBox = (await menu.boundingBox())!;
      const current = (await trigger.boundingBox())!;
      return Math.round(menuBox.y - (current.y + current.height));
    })
    .toBe(8);

  await menu.getByRole("checkbox", { name: /^Rejected/ }).check();
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await expect(page).toHaveURL(/approval=rejected/);
  await expect(trigger.locator("[data-filter-selected]")).toHaveText(
    /^1\s*selected$/,
  );
  expect(await rows.count()).toBeLessThan(total);
  for (const status of await rows
    .locator(".application-status-text")
    .allTextContents())
    expect(status.trim()).toBe("Rejected");

  await page.getByRole("link", { name: "Clear filters" }).click();
  await expect(page).not.toHaveURL(/approval=/);
  await expect(rows).toHaveCount(total);
  await expect(page.getByRole("link", { name: "Clear filters" })).toBeHidden();
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
  const menu = page.locator('[data-filter-menu="sort"]');
  const items = menu.locator("[data-role-order-item]");
  await expect(items).toHaveText([
    "New volunteer",
    "Outreach Volunteer",
    "Medic",
    "Organizer",
  ]);
  const organizer = menu.locator('[data-role-order-item="organizer"]');
  await organizer.focus();
  await page.keyboard.press("ArrowUp");
  await expect(organizer).toBeFocused();
  await expect(items).toHaveText([
    "New volunteer",
    "Outreach Volunteer",
    "Organizer",
    "Medic",
  ]);

  const outreach = menu.locator('[data-role-order-item="volunteer"]');
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
  await menu.getByRole("button", { name: "Apply" }).click();
  await expect(menu).toBeHidden();
  await expect(page).toHaveURL(/order=volunteer%2Cnew%2Corganizer%2Cmedic/);
  expect(await firstPerson()).toBe("outreach-volunteer");

  // Sorting by name hides the role order until Role is chosen again.
  await page.getByRole("button", { name: "Sort: Role" }).click();
  await menu.getByRole("radio", { name: "Name" }).check();
  await expect(menu.locator("[data-role-order]")).toBeHidden();
  await menu.getByRole("radio", { name: "Role" }).check();
  await expect(menu.locator("[data-role-order]")).toBeVisible();
});
