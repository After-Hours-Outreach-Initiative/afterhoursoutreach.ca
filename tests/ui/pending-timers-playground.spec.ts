import { expect, test } from "@playwright/test";

test("change timer playground shows each state, every change and what other organizers see", async ({
  page,
  baseURL,
}) => {
  test.skip(
    !baseURL?.startsWith("http://localhost:"),
    "Requires local development.",
  );
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/dev/ui/pending-timers");
  const scenario = (id: string) =>
    page.locator(`[data-ui-timer-scenario="${id}"]`);

  // Toasts show the change and its timer and link to the item, where Undo
  // and the run button are.
  const waiting = scenario("waiting").locator(".pending-toast");
  const banner = scenario("waiting").locator(".pending-inline");
  await expect(waiting.locator(".pending-icon-waiting svg")).toBeVisible();
  await expect(waiting.locator("[data-pending-timer]")).toHaveText(/^\d:\d\d$/);
  await expect(waiting.getByRole("button")).toHaveCount(0);
  await expect(
    waiting.getByRole("link", { name: "View change" }),
  ).toHaveAttribute("href", "/events#event-patrol");
  await expect(
    banner.getByRole("button", { name: "Cancel event now", exact: true }),
  ).toBeEnabled();
  // The whole toast opens the change: here, its banner on this page.
  await waiting.scrollIntoViewIfNeeded();
  const box = (await waiting.boundingBox())!;
  await page.mouse.click(box.x + box.width - 60, box.y + box.height - 12);
  await expect(banner).toBeFocused();
  await expect(
    scenario("running").locator("[data-pending-timer]").first(),
  ).toHaveText("now");
  await expect(
    scenario("running").getByRole("button", { name: "Cancelling event…" }),
  ).toBeDisabled();
  await expect(
    scenario("failed").getByRole("button", { name: "Dismiss" }),
  ).toBeVisible();
  // A made change says so with a check, without a timer or buttons.
  const done = scenario("done");
  // A made change turns its wording past tense, in the toast and on the item.
  await expect(done.locator(".pending-toast")).toContainText(
    "Cancelled the event on Tue, Nov 17",
  );
  await expect(done.locator(".pending-inline")).toContainText(
    "Cancelled this event",
  );
  await expect(done).not.toContainText("Change made");
  await expect(done.locator(".pending-icon-done").first()).toBeVisible();
  for (const clock of await done.locator("[data-pending-clock]").all())
    await expect(clock).toBeHidden();
  await expect(done.locator("button:visible")).toHaveCount(0);
  // Failures and unconfirmed requests swap the pencil for an alert.
  const failed = scenario("failed");
  await expect(failed).toContainText("Change not made: Cancelling the event");
  await expect(failed.locator(".pending-icon-alert")).toBeVisible();
  await expect(failed.locator(".pending-icon-waiting")).toBeHidden();
  await expect(
    scenario("undo-unconfirmed").locator(".pending-icon-alert").first(),
  ).toBeVisible();
  await expect(waiting.locator(".pending-icon-alert")).toBeHidden();
  await expect(scenario("signed-out")).toContainText("You are signed out.");
  await expect(
    scenario("signed-out-due").locator("[data-pending-clock]"),
  ).toBeHidden();

  // Other organizers see it on the item with the author's name and no
  // buttons, and get a toast only when it refuses their edit.
  const compare = scenario("compare-waiting").locator(".ui-timer-column");
  await expect(compare).toHaveCount(2);
  await expect(compare.nth(0).locator(".pending-toast")).toHaveCount(1);
  await expect(compare.nth(1).locator(".pending-toast")).toHaveCount(0);
  await expect(compare.nth(1).locator(".pending-inline")).toContainText(
    "Nico W. is cancelling",
  );
  await expect(compare.nth(1).locator("button:visible")).toHaveCount(0);
  const blocked = scenario("compare-blocked").locator(".ui-timer-column");
  await expect(blocked.nth(1).locator(".pending-toast")).toContainText(
    "Nico W. is cancelling",
  );
  await expect(blocked.nth(1).locator("button:visible")).toHaveCount(0);

  // Application and patrol approvals appear as toasts and on the person.
  for (const id of ["approve-application", "approve-patrols"]) {
    await expect(scenario(id).locator(".pending-toast")).toHaveCount(1);
    await expect(scenario(id).locator(".pending-inline")).toHaveCount(1);
    await expect(
      scenario(id).getByRole("button", { name: "Approve now" }),
    ).toHaveCount(1);
    await expect(
      scenario(id).getByRole("link", { name: "View change" }),
    ).toHaveAttribute("href", "/volunteers/casey");
  }

  // Long names shorten as in rosters, with the full author name on hover.
  const longNames = scenario("long-names");
  await expect(longNames.locator(".pending-toast").first()).toContainText(
    "Alexanderthegreatest… W.'s application",
  );
  await expect(
    longNames
      .locator(".ui-timer-column")
      .nth(1)
      .locator("[data-pending-actor]")
      .first(),
  ).toHaveAttribute("title", "Maximilianaugustineverylongpreferredname R.");

  await page.getByRole("combobox", { name: "View as" }).selectOption("other");
  await expect(
    scenario("approve-application").locator("button:visible"),
  ).toHaveCount(0);
  await page.getByRole("combobox", { name: "View as" }).selectOption("mine");

  const many = scenario("many");
  // Every toast shows, with no "more" button.
  await expect(many.locator(".pending-toast:visible")).toHaveCount(5);
  await expect(many.getByRole("button", { name: /more/ })).toHaveCount(0);

  // The corner chip hides the toasts until it is opened.
  const closed = scenario("chip-closed");
  const chip = closed.locator("[data-pending-chip]");
  await expect(chip).toHaveAttribute("aria-expanded", "false");
  await expect(chip).toContainText(/\d:\d\d/);
  await expect(closed.locator(".pending-toast:visible")).toHaveCount(0);
  await chip.click();
  await expect(chip).toHaveAttribute("aria-expanded", "true");
  await expect(chip.locator(".pending-chip-open")).toHaveText(
    "Minimize pending changes",
  );
  await expect(chip.locator(".pending-chip-closed")).toBeHidden();
  await expect(closed.locator(".pending-toast:visible")).toHaveCount(3);
  await expect(
    scenario("chip-failed").locator("[data-pending-chip]"),
  ).toContainText("Not made");

  // Buttons change only the preview.
  await banner.getByRole("button", { name: "Undo" }).click();
  // Undo says so briefly, then the change leaves.
  await expect(banner).toContainText("Undone: Cancelling this event");
  await expect(banner.locator(".pending-icon-undone")).toBeVisible();
  await expect(banner.getByRole("button")).toHaveCount(0);
  await expect(banner).toHaveCount(0, { timeout: 4000 });
  await page.getByRole("button", { name: "Restart timers" }).click();
  await expect(scenario("waiting").locator(".pending-inline")).toHaveCount(1);
  expect(errors).toEqual([]);
});
