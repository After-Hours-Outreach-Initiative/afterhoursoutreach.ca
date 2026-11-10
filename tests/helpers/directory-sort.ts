import { expect, type Page } from "@playwright/test";

/** Choose a directory sort through the sort menu, as a person would. */
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
  await menu.getByRole("button", { name: "Apply" }).click();
  await expect(menu).toBeHidden();
  // Closing the menu applies the sort and records it in history.
  await expect.poll(() => page.url()).not.toBe(before);
}

/** The closed sort menu always reflects the applied sort. */
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
