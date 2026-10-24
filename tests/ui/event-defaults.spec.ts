import { expect, test } from "@playwright/test";
import { openLocalAccountSwitcher } from "../helpers/local-account";
import { fillDateInput } from "../helpers/date-input";

test("meeting defaults are submitted for new events without replacing drafts or saved values", async ({
  page,
}) => {
  await page.goto("/volunteer");
  const profiles = await openLocalAccountSwitcher(page);
  await profiles
    .locator('[data-switch-user="local-fixture-user-robin"]')
    .click();
  await page.getByRole("link", { name: "Manage events", exact: true }).click();
  const create = page.locator('[data-show-dialog="event-editor-new"]');
  await create.click();
  const dialog = page.getByRole("dialog", {
    name: "Create event",
    exact: true,
  });
  const form = dialog.locator("[data-event-save]");
  const meeting = form.getByLabel("Meeting point", { exact: true });
  const map = form.getByLabel("Map link (optional)");
  const defaults = {
    meetingPoint: "Lord Strathcona Elementary",
    meetingPointUrl: "https://maps.app.goo.gl/4ommJyZFCRJRGf9F9",
  };
  await expect(meeting).toHaveValue(defaults.meetingPoint);
  await expect(map).toHaveValue(defaults.meetingPointUrl);
  await fillDateInput(form, "startsAt", "2030-01-01T21:00");
  await page.route("**/api/v1/events/action", (route) =>
    route.fulfill({
      status: 503,
      json: { message: "Request inspected without saving." },
    }),
  );
  const submit = async () => {
    const request = page.waitForRequest("**/api/v1/events/action");
    await dialog
      .getByRole("button", { name: "Create event", exact: true })
      .click();
    const body = (await request).postDataJSON();
    await expect(form.locator("[data-form-message]")).toHaveText(
      "Request inspected without saving.",
    );
    await expect(
      dialog.getByRole("button", { name: "Create event", exact: true }),
    ).toBeEnabled();
    return body;
  };
  expect(await submit()).toMatchObject({ action: "save", event: defaults });
  await form.getByLabel("Recurring patrol", { exact: true }).check();
  expect(await submit()).toMatchObject({
    action: "save-series",
    series: defaults,
  });

  await meeting.fill("Custom meeting point");
  await map.fill("");
  await page.keyboard.press("Escape");
  await create.click();
  await expect(meeting).toHaveValue("Custom meeting point");
  await expect(map).toHaveValue("");
  expect(await submit()).toMatchObject({
    action: "save-series",
    series: { meetingPoint: "Custom meeting point", meetingPointUrl: "" },
  });
  await form.evaluate((element: HTMLFormElement) => element.reset());
  await expect(meeting).toHaveValue(defaults.meetingPoint);
  await expect(map).toHaveValue(defaults.meetingPointUrl);
  await page.keyboard.press("Escape");

  for (const [id, point, url] of [
    ["orientation", "Strathcona Community Centre", ""],
    [
      "patrol",
      "Lord Strathcona Elementary School",
      "https://maps.app.goo.gl/y4huzDbXZ7eDmgiv5",
    ],
  ]) {
    const card = page.locator(`[data-live-event="local-fixture-event-${id}"]`);
    await card.getByRole("button", { name: "Edit", exact: true }).click();
    const edit = card.getByRole("dialog", { name: "Edit event", exact: true });
    const editMeeting = edit.getByLabel("Meeting point", { exact: true });
    const editMap = edit.getByLabel("Map link (optional)");
    await expect(editMeeting).toHaveValue(point);
    await expect(editMap).toHaveValue(url);
    await editMeeting.fill("");
    await editMap.fill("");
    await edit.getByLabel("Includes orientation", { exact: true }).check();
    await expect(editMeeting).toHaveValue("");
    await expect(editMap).toHaveValue("");
    await edit
      .locator("[data-event-save]")
      .evaluate((element: HTMLFormElement) => element.reset());
    await expect(editMeeting).toHaveValue(point);
    await expect(editMap).toHaveValue(url);
    await page.keyboard.press("Escape");
    await expect(edit).toBeHidden();
  }
});
