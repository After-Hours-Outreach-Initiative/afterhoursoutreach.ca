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
  await page.goto("/events");
  const cards = page.locator("[data-live-event]").filter({ hasText: label });
  const dates = await cards.evaluateAll((elements) =>
    elements.map((element) => element.getAttribute("data-event-start")),
  );
  const ids = await cards.evaluateAll((elements) =>
    elements.map((element) => element.getAttribute("data-live-event")),
  );
  const selectMode = page.locator("[data-bulk-select-mode]");
  await expect(page.locator("[data-bulk-event]:visible")).toHaveCount(0);
  await selectMode.click();
  await expect(selectMode).toHaveAttribute("aria-pressed", "true");
  await expect(selectMode).toHaveText("Cancel");
  await cards.first().locator("[data-bulk-event]").check();
  await expect(page.locator("[data-bulk-count]")).toHaveText("1 selected");
  await page.getByRole("button", { name: "Clear", exact: true }).click();
  await expect(page.locator("[data-bulk-count]")).toContainText("0 selected");
  const bulkEdit = page.getByRole("button", { name: "Bulk edit", exact: true });
  await expect(bulkEdit).toBeDisabled();
  // Disabled actions must also look unavailable, not only ignore clicks.
  await expect(bulkEdit).toHaveCSS("cursor", "not-allowed");
  await expect(bulkEdit).toHaveCSS(
    "background-color",
    "oklch(0.274 0.006 286.033)",
  );
  await page.getByRole("button", { name: "Select all", exact: true }).click();
  expect(await page.locator("[data-bulk-event]:checked").count()).toBe(
    await page.locator("[data-bulk-event]:visible").count(),
  );
  await page.getByRole("button", { name: "Clear", exact: true }).click();
  for (const checkbox of await cards.locator("[data-bulk-event]").all())
    await checkbox.check();
  await page.getByRole("button", { name: "Bulk edit", exact: true }).click();
  const dialog = page.getByRole("dialog", {
    name: "Bulk edit events",
    exact: true,
  });
  await expect(dialog.locator(".dialog-footer button")).toHaveText([
    "Cancel",
    "Save selected events",
  ]);
  await expect(dialog.locator(".dialog-footer")).toHaveCSS(
    "justify-content",
    "flex-end",
  );
  await expect(dialog.locator("[data-bulk-targets] li")).toHaveCount(2);
  await expect(dialog.locator('[type="checkbox"]')).toHaveCount(0);
  await expect(dialog.locator('[name="startsAt"]')).toHaveCount(0);
  const save = dialog.getByRole("button", { name: "Save selected events" });
  await expect(save).toBeDisabled();
  await expect(save).toHaveCSS("cursor", "not-allowed");
  const meetingPoint = dialog.getByLabel("Meeting point", { exact: true });
  await expect(meetingPoint).toHaveValue("");
  await expect(meetingPoint).toHaveAttribute("placeholder", "Varies");
  await expect(
    dialog.getByLabel("Volunteer spots", { exact: true }),
  ).toHaveValue("8");
  await meetingPoint.fill(`${label} updated`);
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
    .getByRole("group", { name: "Event type" })
    .getByText("Orientation + Patrol", { exact: true })
    .click();
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
    dialog
      .getByRole("group", { name: "Event type" })
      .getByRole("radio", { name: "Orientation + Patrol", exact: true }),
  ).toBeChecked();
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.locator("[data-bulk-count]")).toContainText("0 selected");
  await cards.first().locator("[data-bulk-event]").check();
  await page
    .getByRole("button", { name: "Exit selection mode", exact: true })
    .click();
  await expect(page.locator("[data-bulk-actions]")).toBeHidden();
  await expect(page.locator("[data-bulk-event]:visible")).toHaveCount(0);
  await expect(page.locator("[data-bulk-event]:checked")).toHaveCount(0);
  await expect(selectMode).toHaveAttribute("aria-pressed", "false");
  await expect(selectMode).toHaveText("Select");
  await expect(selectMode).toBeFocused();
});
