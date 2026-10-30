import { expect, test } from "@playwright/test";
import { openLocalAccountSwitcher } from "../helpers/local-account";
import { fillDateInput } from "../helpers/date-input";

test("organizers switch event views without losing filters or occurrence links", async ({
  page,
}) => {
  await page.goto("/volunteer");
  await (
    await openLocalAccountSwitcher(page)
  )
    .locator('[data-switch-user="local-fixture-user-robin"]')
    .click();
  await expect(page.locator("[data-event-list]")).toBeVisible();
  await page.goto("/events?occurrence=local-fixture-event-orientation");
  const views = page.getByRole("group", { name: "View as", exact: true });
  const organizer = views.getByRole("link", { name: "Organizer", exact: true });
  const volunteer = views.getByRole("link", { name: "Volunteer", exact: true });
  await expect(organizer).toHaveAttribute("aria-current", "page");
  await expect(
    page.locator('[data-show-dialog="event-editor-new"]'),
  ).toBeVisible();
  await page.getByRole("button", { name: /^Orientations \(/ }).click();
  await expect(volunteer).toHaveAttribute("href", /view=volunteer/);
  await volunteer.click();
  expect(new URL(page.url()).searchParams.get("type")).toBe("orientation");
  expect(new URL(page.url()).searchParams.get("occurrence")).toBe(
    "local-fixture-event-orientation",
  );
  await expect(volunteer).toHaveAttribute("aria-current", "page");
  await expect(page.locator("[data-event-calendar]")).toBeVisible();
  await expect(
    page.locator("[data-event-save], [data-manage-signup]"),
  ).toHaveCount(0);
  await page.getByRole("button", { name: /^All \(/ }).click();
  await organizer.click();
  expect(new URL(page.url()).searchParams.has("type")).toBe(false);
  await expect(organizer).toHaveAttribute("aria-current", "page");
  await page.getByRole("button", { name: /^One-off events \(/ }).click();
  await volunteer.click();
  await expect(page.getByRole("button", { name: /^All \(/ })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(page.locator('a[href^="/manage"]')).toHaveCount(0);
});

test("meeting and volunteer-limit defaults are submitted without replacing drafts or saved values", async ({
  page,
}) => {
  await page.goto("/volunteer");
  const profiles = await openLocalAccountSwitcher(page);
  await profiles
    .locator('[data-switch-user="local-fixture-user-robin"]')
    .click();
  await page.getByRole("link", { name: "Organizer", exact: true }).click();
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
    minMedicSpots: 2,
    minNewVolunteerSpots: 2,
    maxNewVolunteers: 4,
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
  await form.getByLabel("Minimum medic spots", { exact: true }).fill("3");
  await form
    .getByLabel("Minimum new volunteer spots", { exact: true })
    .fill("1");
  await form.getByLabel("Maximum new volunteers", { exact: true }).fill("2");
  await form.getByLabel("Includes orientation", { exact: true }).check();
  await expect(
    form.getByLabel("Volunteer spots", { exact: true }),
  ).toHaveAttribute("min", "4");
  await page.keyboard.press("Escape");
  await create.click();
  await expect(meeting).toHaveValue("Custom meeting point");
  await expect(map).toHaveValue("");
  expect(await submit()).toMatchObject({
    action: "save-series",
    series: {
      meetingPoint: "Custom meeting point",
      meetingPointUrl: "",
      minMedicSpots: 3,
      minNewVolunteerSpots: 1,
      maxNewVolunteers: 2,
    },
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
