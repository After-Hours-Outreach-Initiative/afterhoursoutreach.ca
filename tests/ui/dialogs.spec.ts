import { expect, test, type Locator } from "@playwright/test";
import { openLocalAccountSwitcher } from "../helpers/local-account";
import { fillDateInput } from "../helpers/date-input";
import { inPlaceAction } from "../helpers/in-place-action";
import { addCalendarDays, vancouverInput } from "../../src/data/event-time";

async function expectPinnedChrome(dialog: Locator) {
  await expect(dialog).toBeInViewport({ ratio: 1 });
  await dialog.evaluate(async (element) => {
    await Promise.allSettled(
      element.getAnimations().map((animation) => animation.finished),
    );
  });
  const header = dialog.locator(".dialog-header");
  const footer = dialog.locator(".dialog-footer");
  const before = {
    header: await header.boundingBox(),
    footer: (await footer.count()) ? await footer.boundingBox() : null,
  };
  await dialog.locator(".dialog-body").evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  expect(await header.boundingBox()).toEqual(before.header);
  if (before.footer) expect(await footer.boundingBox()).toEqual(before.footer);
  expect(
    await dialog.evaluate((element) => ({
      scrolled: element.scrollTop,
      overflow: element.scrollWidth > element.clientWidth,
    })),
  ).toEqual({ scrolled: 0, overflow: false });
  const close = header.getByRole("button");
  await expect(close).toHaveAccessibleName(/Close/);
  await expect(close.locator("svg")).toHaveAttribute("aria-hidden", "true");
  await expect(close).toHaveText("");
}

async function expectStableExit(dialog: Locator) {
  const { before, frames } = await dialog.evaluate(async (element) => {
    const dialog = element as HTMLDialogElement;
    await Promise.allSettled(
      dialog.getAnimations().map((animation) => animation.finished),
    );
    const body = dialog.querySelector<HTMLElement>(".dialog-body")!;
    body.scrollTop = body.scrollHeight;
    const layout = () => ({
      width: dialog.offsetWidth,
      height: dialog.offsetHeight,
      bodyWidth: body.offsetWidth,
      bodyHeight: body.offsetHeight,
      children: body.childElementCount,
      scroll: body.scrollTop,
    });
    const before = layout();
    dialog.querySelector<HTMLButtonElement>(".dialog-close")!.click();
    const frames: ReturnType<typeof layout>[] = [];
    while (getComputedStyle(dialog).display !== "none") {
      frames.push(layout());
      await new Promise(requestAnimationFrame);
    }
    return { before, frames };
  });
  expect(frames.length).toBeGreaterThan(0);
  for (const frame of frames) expect(frame).toEqual(before);
}

test("event and series edit dialogs keep deletion available for ended and cancelled events", async ({
  page,
  baseURL,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/volunteer");
  await (
    await openLocalAccountSwitcher(page)
  )
    .locator('[data-switch-user="local-fixture-user-robin"]')
    .click();
  await page.getByRole("link", { name: "Manage events", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Create", exact: true }),
  ).toBeVisible();
  const action = async (data: object) => {
    const response = await page.request.post("/api/v1/events/action", {
      headers: { origin: baseURL! },
      data,
    });
    expect(response.status(), await response.text()).toBe(200);
    return await response.json();
  };
  const firstDate = addCalendarDays(vancouverInput(Date.now()).slice(0, 10), 1);
  const fields = {
    meetingPoint: `Dialog regression ${crypto.randomUUID()}`,
    meetingPointUrl: "",
    spots: 8,
    includesOrientation: false,
    open: true,
    hidden: false,
  };
  const series = await action({
    action: "save-series",
    series: {
      ...fields,
      firstDate,
      localTime: "21:00",
      intervalWeeks: 1,
      endDate: addCalendarDays(firstDate, 14),
    },
  });
  await action({
    action: "save",
    event: {
      ...fields,
      startsAt: new Date(Date.now() + 86_400_000).toISOString(),
    },
  });
  await page.goto("/manage/events");
  const standaloneId = await page
    .locator("[data-event-list] > [data-live-event]")
    .filter({ hasText: fields.meetingPoint })
    .getAttribute("data-live-event");
  const occurrenceId = `patrol:${series.id}:${firstDate}`;
  for (const id of [standaloneId, occurrenceId]) {
    const form = page.locator(`[data-live-event="${id}"] [data-event-cancel]`);
    await action({
      action: "cancel-event",
      id,
      version: Number(await form.locator('[name="version"]').inputValue()),
    });
  }
  await page.reload();
  const group = page.locator(`[data-series-card="${series.id}"]`);
  const seriesButton = group.getByRole("button", {
    name: "Edit series",
    exact: true,
  });
  await seriesButton.focus();
  await seriesButton.press("Enter");
  const settings = group.getByRole("dialog", {
    name: "Edit series",
    exact: true,
  });
  await expect(settings.locator("details")).toHaveCount(0);
  await expectPinnedChrome(settings);
  await settings
    .getByLabel("Meeting point", { exact: true })
    .fill("Saved series meeting point");
  await page.keyboard.press("Escape");
  await expect(seriesButton).toBeFocused();
  await seriesButton.press("Space");
  await expect(
    settings.getByLabel("Meeting point", { exact: true }),
  ).toHaveValue("Saved series meeting point");
  await settings
    .getByRole("button", { name: "Save series defaults", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Save without email", exact: true })
    .click();
  await expect(settings).toBeHidden();
  await expect(seriesButton).toBeFocused();
  await group.locator("[data-series-occurrences] > summary").click();

  const activeOccurrenceId = `patrol:${series.id}:${addCalendarDays(firstDate, 7)}`;
  for (const [id, editable, recurring] of [
    ["local-fixture-event-orientation", true, false],
    ["local-fixture-event-past-orientation", false, false],
    [standaloneId, false, false],
    [occurrenceId, false, true],
    [activeOccurrenceId, true, true],
  ] as const) {
    const card = page.locator(`[data-live-event="${id}"]`);
    await expect(
      card
        .locator(".volunteer-actions")
        .getByRole("button", { name: /Delete/ }),
    ).toHaveCount(0);
    const edit = card.getByRole("button", { name: "Edit", exact: true });
    await edit.focus();
    await edit.press("Enter");
    const dialog = card.getByRole("dialog", {
      name: "Edit event",
      exact: true,
    });
    await expect(
      dialog.locator("[data-event-save], [data-event-cancel]"),
    ).toHaveCount(editable ? 2 : 0);
    if (editable && recurring) {
      await expect(dialog.getByLabel("Apply changes to")).toHaveValue(
        "occurrence",
      );
      await expect(
        dialog.locator('[data-event-cancel] [name="scope"]'),
      ).toHaveValue("occurrence");
    }
    const remove = dialog.getByRole("button", {
      name: recurring ? "Delete occurrence" : "Delete event",
      exact: true,
    });
    await remove.click();
    const confirmation = page.getByRole("dialog", {
      name: recurring ? "Delete occurrence?" : "Delete event?",
      exact: true,
    });
    await confirmation
      .getByRole("button", { name: "Keep", exact: true })
      .click();
    await expect(dialog).toBeVisible();
    await expect(remove).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(edit).toBeFocused();
  }
  expect(
    await page.locator("dialog[id]").evaluateAll((dialogs) => {
      const ids = dialogs.map((dialog) => dialog.id);
      return new Set(ids).size === ids.length;
    }),
  ).toBe(true);
  const cancelled = page.locator(`[data-live-event="${standaloneId}"]`);
  await cancelled.getByRole("button", { name: "Edit", exact: true }).click();
  await cancelled
    .getByRole("button", { name: "Delete event", exact: true })
    .click();
  await page
    .getByRole("dialog", { name: "Delete event?", exact: true })
    .getByRole("button", { name: "Delete", exact: true })
    .click();
  await expect(cancelled).toHaveCount(0);
  await seriesButton.click();
  await settings
    .getByRole("button", { name: "Delete series", exact: true })
    .click();
  await page
    .getByRole("dialog", { name: "Delete series?", exact: true })
    .getByRole("button", { name: "Delete", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Save without email", exact: true })
    .click();
  await expect(group).toHaveCount(0);
});

test("event and profile dialogs preserve their layout and content throughout the exit transition", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto("/volunteer");
  await (
    await openLocalAccountSwitcher(page)
  )
    .locator('[data-switch-user="local-fixture-user-robin"]')
    .click();
  await expect(page.locator("[data-event-list]")).toBeVisible();

  for (const width of [1280, 320]) {
    await page.setViewportSize({ width, height: width === 320 ? 568 : 900 });
    await page.goto("/manage/events");
    await page.getByRole("button", { name: "Create", exact: true }).click();
    await expectStableExit(page.locator("#event-editor-new"));
    await page
      .locator('[data-live-event="local-fixture-event-orientation"]')
      .getByRole("button", { name: "Edit", exact: true })
      .click();
    await expectStableExit(page.getByRole("dialog", { name: "Edit event" }));

    const roster = page.locator(
      '[data-live-event="local-fixture-event-orientation"] .volunteer-roster',
    );
    await roster.locator("summary").click();
    await roster.locator("[data-volunteer-profile-link]").first().click();
    const profile = page.locator("[data-volunteer-profile-dialog]");
    await expect(profile.locator("[data-volunteer-profile]")).toBeVisible();
    await expect(profile.locator(".volunteer-profile-loading")).toHaveCount(0);
    const profilePanel = profile.getByRole("tabpanel", {
      name: "Profile",
      exact: true,
    });
    await expect(profilePanel).toBeVisible();
    await expect(profilePanel.getByRole("heading")).toHaveText([
      "Personal info",
      "Emergency contact",
      "Team interests",
      "Training and safety",
    ]);
    const controls = profile.locator(
      '[data-volunteer-profile-panel="application"] + [data-volunteer-controls]',
    );
    await expect(controls).toBeVisible();
    await profile
      .getByRole("tab", { name: "Application", exact: true })
      .click();
    const applicationPanel = profile.getByRole("tabpanel", {
      name: "Application",
      exact: true,
    });
    await expect(applicationPanel).toBeVisible();
    await expect(applicationPanel.getByRole("heading")).toHaveText([
      "Submission details",
      "Personal info",
      "Emergency contact",
      "Team interests",
      "Training and safety",
      "Personal statement",
    ]);
    await expect(controls).toBeVisible();
    await expectStableExit(profile);
    await expect(profile.locator("[data-profile-dialog-content]")).toBeEmpty();
  }
});

test("application dialogs keep their chrome visible while only their body scrolls", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/volunteer");
  await (
    await openLocalAccountSwitcher(page)
  )
    .locator('[data-switch-user="local-fixture-user-robin"]')
    .click();
  await expect(page.locator("[data-event-list]")).toBeVisible();
  await page.goto("/manage/events");
  await page.route("**/api/v1/events/action", (route) =>
    route.fulfill({ status: 503, json: { message: "Please try again." } }),
  );

  for (const width of [1280, 320]) {
    await page.setViewportSize({ width, height: width === 320 ? 568 : 900 });
    await openLocalAccountSwitcher(page);
    const development = page.getByRole("dialog", { name: "DEV panel" });
    await expectPinnedChrome(development);
    await development.locator(".dialog-close").click();
    await expect(
      page.getByRole("button", { name: "DEV panel", exact: true }),
    ).toBeFocused();

    const add = page.locator('[data-show-dialog="event-editor-new"]');
    await add.click();
    const create = page.getByRole("dialog", { name: "Create event" });
    await expectPinnedChrome(create);
    await expect(create.locator(".dialog-header h2")).toHaveCSS(
      "font-size",
      width === 320 ? "20px" : "24px",
    );
    if (width === 320)
      expect(
        await create
          .locator(".dialog-body")
          .evaluate((element) => element.scrollTop),
      ).toBeGreaterThan(0);
    expect(
      await create
        .getByRole("button", { name: "Create event" })
        .evaluate((element: HTMLButtonElement) =>
          element.form?.hasAttribute("data-event-save"),
        ),
    ).toBe(true);
    if (width === 320) {
      await fillDateInput(create, "startsAt", "2030-01-01T20:00");
      await create
        .getByLabel("Meeting point", { exact: true })
        .fill("Test point");
      await inPlaceAction(page, {
        endpoint: "/api/v1/events/action",
        form: create.locator("[data-event-save]"),
        trigger: () =>
          create.getByRole("button", { name: "Create event" }).click(),
        updated: () =>
          expect(create.locator("[data-form-message]")).toHaveText(
            "Please try again.",
          ),
        loadingLabel: "Creating…",
        pending: async () => {
          await expect(
            create.getByRole("spinbutton", { name: "Volunteer spots" }),
          ).toBeDisabled();
          for (const name of [
            "Decrease volunteer spots",
            "Increase volunteer spots",
          ])
            await expect(create.getByRole("button", { name })).toBeDisabled();
        },
      });
      await expect(
        create.getByRole("button", { name: "Create event" }),
      ).toBeEnabled();
      await expect(create.locator("[data-form-message]")).toBeInViewport();
      for (const name of [
        "Decrease volunteer spots",
        "Increase volunteer spots",
      ])
        await expect(create.getByRole("button", { name })).toBeEnabled();
    }
    await page.keyboard.press("Escape");
    await expect(add).toBeFocused();

    const card = page.locator(
      '[data-live-event="local-fixture-event-orientation"]',
    );
    await card.getByRole("button", { name: "Edit", exact: true }).click();
    const edit = page.getByRole("dialog", { name: "Edit event" });
    await expectPinnedChrome(edit);
    await edit.locator(".dialog-close").click();
    const roster = card.locator(".volunteer-roster");
    if (!(await roster.evaluate((element: HTMLDetailsElement) => element.open)))
      await roster.locator("summary").click();
    await card.locator("[data-signup-menu-trigger]").first().click();
    await card.getByRole("menuitem", { name: "Remove volunteer" }).click();
    const registration = page.getByRole("dialog", {
      name: "Change a registration",
    });
    await expectPinnedChrome(registration);
    await registration.locator(".dialog-close").click();
  }

  await page
    .locator(".volunteer-roster[open] [data-volunteer-profile-link]")
    .first()
    .click();
  const profile = page.getByRole("dialog", {
    name: "Volunteer profile",
    exact: true,
  });
  await expect(profile.locator("[data-volunteer-profile]")).toBeVisible();
  await expectPinnedChrome(profile);
  await expect(profile.locator(".dialog-footer")).toHaveCount(0);
  await profile.locator(".dialog-close").click();
});
