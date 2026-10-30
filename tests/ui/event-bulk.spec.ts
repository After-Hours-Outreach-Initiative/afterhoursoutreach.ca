import { expect, test } from "@playwright/test";
import { openLocalAccountSwitcher } from "../helpers/local-account";

test("organizer bulk selection stays visible, preserves dates and invalidates stale dialog targets", async ({
  page,
  baseURL,
}) => {
  test.setTimeout(60_000);
  await page.goto("/volunteer");
  await (
    await openLocalAccountSwitcher(page)
  )
    .locator('[data-switch-user="local-fixture-user-robin"]')
    .click();
  await expect(
    page.getByRole("button", { name: "Create", exact: true }),
  ).toBeVisible();
  const label = `Bulk selection ${crypto.randomUUID()}`;
  for (const days of [1, 2]) {
    const response = await page.request.post("/api/v1/events/action", {
      headers: { origin: baseURL! },
      data: {
        action: "save",
        event: {
          includesOrientation: false,
          startsAt: new Date(Date.now() + days * 86_400_000).toISOString(),
          meetingPoint: `${label} ${days}`,
          meetingPointUrl: "",
          spots: 8,
          open: true,
          hidden: false,
        },
      },
    });
    expect(response.status(), await response.text()).toBe(200);
  }
  await page.goto("/events?type=one-off");
  const cards = page.locator("[data-live-event]").filter({ hasText: label });
  const dates = await cards.evaluateAll((elements) =>
    elements.map((element) => element.getAttribute("data-event-start")),
  );
  const ids = await cards.evaluateAll((elements) =>
    elements.map((element) => element.getAttribute("data-live-event")),
  );
  await cards.first().locator("[data-bulk-event]").check();
  await expect(page.locator("[data-bulk-count]")).toHaveText("1 selected");
  await page
    .getByRole("button", { name: /^Recurring events \(\d+\)$/ })
    .click();
  await expect(page.locator("[data-bulk-count]")).toContainText("0 selected");
  await expect(
    page.getByRole("button", { name: "Bulk edit", exact: true }),
  ).toBeDisabled();
  await page.getByRole("button", { name: /^One-off events \(\d+\)$/ }).click();
  await page
    .getByRole("button", { name: "Select all shown", exact: true })
    .click();
  expect(await page.locator("[data-bulk-event]:checked").count()).toBe(
    await page.locator("[data-bulk-event]:visible").count(),
  );
  await page
    .getByRole("button", { name: "Clear selection", exact: true })
    .click();
  for (const checkbox of await cards.locator("[data-bulk-event]").all())
    await checkbox.check();
  await page.getByRole("button", { name: "Bulk edit", exact: true }).click();
  const dialog = page.getByRole("dialog", {
    name: "Bulk edit events",
    exact: true,
  });
  await expect(dialog).toContainText("not entire recurring series");
  await expect(dialog.locator('[name="startsAt"]')).toHaveCount(0);
  await expect(
    dialog.getByRole("button", { name: "Save selected events" }),
  ).toBeDisabled();
  await dialog.getByLabel("Change meeting point", { exact: true }).check();
  await dialog
    .getByLabel("Meeting point", { exact: true })
    .fill(`${label} updated`);
  const submitted = page.waitForRequest(
    (request) =>
      request.url().endsWith("/api/v1/events/action") &&
      request.method() === "POST",
  );
  await dialog.getByRole("button", { name: "Save selected events" }).click();
  await page
    .getByRole("button", { name: "Save without email", exact: true })
    .click();
  const body = (await submitted).postDataJSON();
  expect(body.changes).toEqual({ meetingPoint: `${label} updated` });
  expect(body.selection.map((row: { id: string }) => row.id)).toEqual(ids);
  expect(body.notify).toBe(false);
  await expect(dialog).not.toBeVisible();
  await expect(cards.first()).toContainText(`${label} updated`);
  expect(
    await cards.evaluateAll((elements) =>
      elements.map((element) => element.getAttribute("data-event-start")),
    ),
  ).toEqual(dates);
  await expect(page.locator("[data-bulk-event]:checked")).toHaveCount(0);
  // A background update cannot silently replace the dialog's optimistic version.
  await cards.first().locator("[data-bulk-event]").check();
  await page.getByRole("button", { name: "Bulk edit", exact: true }).click();
  await dialog
    .getByRole("combobox", { name: "Includes orientation", exact: true })
    .selectOption("true");
  const selection = JSON.parse(
    await dialog.locator('[name="selection"]').inputValue(),
  );
  const changed = await page.request.post("/api/v1/events/action", {
    headers: { origin: baseURL! },
    data: { action: "bulk-save", selection, changes: { spots: 10 } },
  });
  expect(changed.status(), await changed.text()).toBe(200);
  await expect(dialog.locator("[data-bulk-stale]")).toBeVisible({
    timeout: 15_000,
  });
  await expect(
    dialog.getByRole("button", { name: "Save selected events" }),
  ).toBeDisabled();
  await expect(
    dialog.getByRole("combobox", { name: "Includes orientation", exact: true }),
  ).toHaveValue("true");
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.locator("[data-bulk-count]")).toContainText("0 selected");
});
