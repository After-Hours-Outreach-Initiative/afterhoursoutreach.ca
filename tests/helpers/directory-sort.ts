import { expect, type Page } from "@playwright/test";

/**
 * Choose a directory sort from the sort menu, as a person would. With scripts,
 * each change applies at once and is recorded in history.
 */
export async function sortDirectory(
  page: Page,
  sort: string,
  direction: "asc" | "desc",
) {
  const menu = page.locator('[data-filter-menu="sort"]');
  const before = page.url();
  await page.getByRole("button", { name: /^Sort:/ }).click();
  await menu.locator(`input[name="sort"][value="${sort}"]`).check();
  await menu.locator(`input[name="direction"][value="${direction}"]`).check();
  // Without scripts, the menu applies through its Apply button.
  const apply = menu.getByRole("button", { name: "Apply" });
  if (await apply.isVisible()) await apply.click();
  else await page.keyboard.press("Escape");
  await expect.poll(() => page.url()).not.toBe(before);
}

/** The sort controls always reflect the applied sort. */
export async function expectDirectorySort(
  page: Page,
  sort: string,
  direction: "asc" | "desc",
) {
  const form = page.locator("[data-volunteer-search-form]");
  await expect(form.locator('[name="sort"]:checked')).toHaveValue(sort);
  await expect(form.locator('[name="direction"]:checked')).toHaveValue(
    direction,
  );
}
