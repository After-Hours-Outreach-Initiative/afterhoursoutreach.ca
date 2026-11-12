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
  if (await footer.isVisible()) {
    await expect(footer).toHaveCSS("justify-content", "flex-end");
    expect(
      await footer.evaluate((element) => {
        const last = element.querySelector<HTMLElement>(".btn:last-child")!;
        return Math.abs(
          element.getBoundingClientRect().right -
            parseFloat(getComputedStyle(element).paddingRight) -
            last.getBoundingClientRect().right,
        );
      }),
    ).toBeLessThan(1);
  }
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

test("event dialogs offer only cancellation for future events and keep ended history read-only", async ({
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
  await page.goto("/events");
  const standaloneId = await page
    .locator("[data-event-list] > [data-live-event]:not([data-event-series])")
    .filter({ hasText: fields.meetingPoint })
    .getAttribute("data-live-event");
  const occurrenceId = `patrol:${series.id}:${firstDate}`;
  for (const id of [standaloneId, occurrenceId]) {
    const form = page.locator(`[data-live-event="${id}"] [data-event-cancel]`);
    if (id === standaloneId) {
      const card = page.locator(`[data-live-event="${id}"]`);
      await card.getByRole("button", { name: "Edit", exact: true }).click();
      const dialog = card.getByRole("dialog", {
        name: "Edit event",
        exact: true,
      });
      await dialog
        .getByRole("button", { name: "Cancel event", exact: true })
        .click();
      await expect(card).toBeVisible();
      await expect(form).toBeFocused();
      await expect(form.locator("[data-event-cancel-reason]")).toBeHidden();
      await form
        .getByRole("button", { name: "Confirm cancellation", exact: true })
        .click();
      await expect(card).toHaveCount(0);
      continue;
    }
    await action({
      action: "cancel-event",
      id,
      version: Number(await form.locator('[name="version"]').inputValue()),
    });
  }
  await page.reload();
  await expect(page.locator(`[data-live-event="${standaloneId}"]`)).toHaveCount(
    0,
  );
  // Organizers keep a cancelled series date so they can restore it.
  const cancelledOccurrence = page.locator(
    `[data-live-event="${occurrenceId}"]`,
  );
  await expect(cancelledOccurrence.locator(".volunteer-hidden")).toHaveText(
    "Cancelled",
  );
  const activeOccurrenceId = `patrol:${series.id}:${addCalendarDays(firstDate, 7)}`;
  for (const [id, editable, recurring] of [
    ["local-fixture-event-orientation", true, false],
    ["local-fixture-event-past-orientation", false, false],
    [activeOccurrenceId, true, true],
  ] as const) {
    const card = page.locator(`[data-live-event="${id}"]`);
    await expect(
      card
        .locator(".volunteer-actions")
        .getByRole("button", { name: /Delete/ }),
    ).toHaveCount(0);
    const edit = card.getByRole("button", { name: "Edit", exact: true });
    if (!editable) {
      await expect(
        page.locator(`[data-past-event-list] [data-live-event="${id}"]`),
      ).toBeVisible();
      await expect(edit).toHaveCount(0);
      await expect(
        card.locator("[data-event-save], [data-event-cancel]"),
      ).toHaveCount(0);
      await expect(
        card.getByRole("button", { name: "Cancel event", exact: true }),
      ).toHaveCount(0);
      await card.locator(".volunteer-roster > summary").click();
      await expect(card.locator(".volunteer-roster")).toHaveAttribute(
        "open",
        "",
      );
      continue;
    }
    await edit.focus();
    await edit.press("Enter");
    const dialog = card.getByRole("dialog", {
      name: recurring ? "Edit recurring event" : "Edit event",
      exact: true,
    });
    await expect(
      dialog.locator("[data-event-save], [data-event-cancel]"),
    ).toHaveCount(editable ? 2 : 0);
    if (editable && recurring) {
      await expect(
        dialog.locator(
          '[data-event-cancel] [name="scope"][value="occurrence"]',
        ),
      ).toBeChecked();
    }
    await expect(dialog.getByRole("button", { name: /Delete/ })).toHaveCount(0);
    const cancel = dialog.locator("[data-event-cancel-open]");
    const cancelForm = dialog.locator("[data-event-cancel]");
    await expect(cancel).toHaveCount(1);
    await expect(
      dialog.locator(".dialog-footer [data-event-cancel-open]"),
    ).toHaveCount(0);
    await expect(
      dialog.locator(".dialog-body [data-event-cancel-open]"),
    ).toHaveCount(1);
    await expect(dialog.getByText(/If anyone has ever registered/)).toHaveCount(
      0,
    );
    await expect(cancelForm).toHaveAttribute("inert", "");
    await expect(cancelForm).toHaveAttribute("aria-hidden", "true");
    await cancel.focus();
    await cancel.press("Enter");
    await expect(cancel).toHaveAttribute("aria-expanded", "true");
    await expect(cancelForm).toHaveAttribute("aria-hidden", "false");
    await expect(cancelForm).toBeFocused();
    await expect(
      cancelForm.getByRole("heading", { name: "Cancel event?", exact: true }),
    ).toBeVisible();
    if (recurring) {
      await cancelForm
        .getByText("This and following events", { exact: true })
        .click();
      await expect(
        cancelForm.locator("[data-event-cancel-reason]"),
      ).toBeHidden();
    }
    await cancelForm.getByRole("button", { name: "Keep event" }).click();
    await expect(cancel).toBeFocused();
    await expect(cancel).toHaveAttribute("aria-expanded", "false");
    await cancel.press("Space");
    await expect(cancelForm).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeVisible();
    await expect(cancel).toBeFocused();
    await expect(cancelForm).toHaveAttribute("inert", "");
    await page.keyboard.press("Escape");
    await expect(edit).toBeFocused();
  }
  expect(
    await page.locator("dialog[id]").evaluateAll((dialogs) => {
      const ids = dialogs.map((dialog) => dialog.id);
      return new Set(ids).size === ids.length;
    }),
  ).toBe(true);
  // A cancelled date offers Restore in place of Edit, without an editor.
  await expect(
    cancelledOccurrence.getByRole("button", { name: "Edit", exact: true }),
  ).toHaveCount(0);
  await expect(cancelledOccurrence.locator("dialog")).toHaveCount(0);
  // Restoring asks first; cancelling the prompt leaves the date cancelled.
  const restore = cancelledOccurrence.getByRole("button", {
    name: "Restore",
    exact: true,
  });
  const confirm = page.getByRole("dialog", {
    name: "Restore this event?",
    exact: true,
  });
  await restore.click();
  await confirm.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(confirm).toHaveCount(0);
  await expect(restore).toBeFocused();
  await expect(cancelledOccurrence.locator(".volunteer-hidden")).toHaveCount(1);
  await restore.click();
  await confirm.getByRole("button", { name: "Restore", exact: true }).click();
  await expect(cancelledOccurrence.locator(".volunteer-hidden")).toHaveCount(0);
  await expect(
    cancelledOccurrence.getByRole("button", { name: "Edit", exact: true }),
  ).toBeFocused();
});

test("event cancellation morphs in place and preserves its draft after failure", async ({
  page,
}) => {
  await page.goto("/volunteer");
  await (
    await openLocalAccountSwitcher(page)
  )
    .locator('[data-switch-user="local-fixture-user-robin"]')
    .click();
  await expect(page.locator("[data-event-list]")).toBeVisible();
  await page.route("**/api/v1/events/action", (route) =>
    route.fulfill({ status: 503, json: { message: "Please try again." } }),
  );

  for (const width of [1280, 320]) {
    await page.emulateMedia({
      reducedMotion: width === 320 ? "reduce" : "no-preference",
    });
    await page.setViewportSize({ width, height: width === 320 ? 568 : 900 });
    await page.goto("/events");
    const card = page.locator(
      '[data-live-event="local-fixture-event-orientation"]',
    );
    await card.getByRole("button", { name: "Edit", exact: true }).click();
    const dialog = card.getByRole("dialog", {
      name: "Edit event",
      exact: true,
    });
    const footer = dialog.locator(".dialog-footer");
    await expect(footer.getByRole("button")).toHaveText(["Cancel", "Save"]);
    await expect(footer.getByRole("button", { name: "Cancel" })).toHaveClass(
      "btn btn-quiet",
    );
    await expect(
      footer.getByRole("button", { name: "Cancel" }),
    ).toHaveAttribute("type", "button");
    await footer.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toBeHidden();
    await card.getByRole("button", { name: "Edit", exact: true }).click();
    const form = dialog.locator("[data-event-cancel]");
    const morph = dialog.locator("event-cancellation");
    if (width === 320) {
      await expect(morph.locator(".cancellation-trigger")).toHaveCSS(
        "text-align",
        "center",
      );
      expect(
        await morph
          .locator(".cancellation-trigger")
          .evaluate((trigger) =>
            Math.abs(
              trigger.getBoundingClientRect().width -
                trigger.parentElement!.clientWidth,
            ),
          ),
      ).toBeLessThan(1);
    }
    await dialog
      .getByRole("button", { name: "Cancel event", exact: true })
      .click();
    await morph.locator(".cancellation-surface").evaluate(async (surface) => {
      await Promise.allSettled(
        surface.getAnimations().map((animation) => animation.finished),
      );
    });
    await expect
      .poll(() =>
        morph.locator(".cancellation-surface").evaluate((surface) => {
          const bounds = surface.getBoundingClientRect();
          const body = surface.closest(".dialog-body")!.getBoundingClientRect();
          return (
            bounds.top >= body.top - 1 &&
            (bounds.height > body.height || bounds.bottom <= body.bottom + 1)
          );
        }),
      )
      .toBe(true);
    await form.getByLabel("Reason (optional)").fill("Unsafe conditions");
    await expectPinnedChrome(dialog);
    expect(
      await dialog.evaluate(
        (element) => element.scrollWidth > element.clientWidth,
      ),
    ).toBe(false);
    const confirm = form.getByRole("button", {
      name: "Confirm cancellation",
      exact: true,
    });
    await expect(form.locator(".cancellation-actions button")).toHaveText([
      "Keep event",
      "Confirm cancellation",
    ]);
    await expect(form.locator(".cancellation-actions")).toHaveCSS(
      "justify-content",
      "flex-end",
    );

    await inPlaceAction(page, {
      endpoint: "/api/v1/events/action",
      form,
      trigger: () => confirm.click(),
      updated: () =>
        expect(form.locator("[data-form-message]")).toHaveText(
          "Please try again.",
        ),
      loadingLabel: "Sending…",
      pending: async () => {
        await expect(
          form.getByRole("button", { name: "Keep event" }),
        ).toBeDisabled();
        await expect(
          dialog.getByRole("button", { name: "Save", exact: true }),
        ).toBeDisabled();
        await expect(morph).toHaveAttribute("data-expanded", "");
      },
    });
    await expect(confirm).toBeEnabled();
    await expect(form.getByLabel("Reason (optional)")).toHaveValue(
      "Unsafe conditions",
    );
    await form.getByRole("button", { name: "Keep event" }).click();
    await expect(
      dialog.getByRole("button", { name: "Cancel event", exact: true }),
    ).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
  }
});

test("event dialogs preserve their exit layout and roster profiles navigate to pages", async ({
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
    await page.goto("/events");
    await page.getByRole("button", { name: "Create", exact: true }).click();
    const create = page.locator("#event-editor-new");
    const footer = create.locator(".dialog-footer");
    await expect(footer.getByRole("button")).toHaveText(["Cancel", "Create"]);
    const cancel = footer.getByRole("button", { name: "Cancel", exact: true });
    await expect(cancel).toHaveClass("btn btn-quiet");
    await expect(cancel).toHaveAttribute("type", "button");
    await expect(
      footer.getByRole("button", { name: "Create" }),
    ).toHaveAttribute("form", "event-editor-new-save");
    await expect(
      footer.getByRole("button", { name: "Create" }),
    ).toHaveAttribute("type", "submit");
    await expectPinnedChrome(create);
    await cancel.click();
    await expect(create).toBeHidden();
    await page.getByRole("button", { name: "Create", exact: true }).click();
    await expectStableExit(create);
    await page
      .locator('[data-live-event="local-fixture-event-orientation"]')
      .getByRole("button", { name: "Edit", exact: true })
      .click();
    await expectStableExit(page.getByRole("dialog", { name: "Edit event" }));

    const roster = page.locator(
      '[data-live-event="local-fixture-event-orientation"] .volunteer-roster',
    );
    await roster.locator("summary").click();
    const link = roster.locator("[data-volunteer-profile-link]").first();
    const profileUrl = new URL((await link.getAttribute("href"))!, page.url())
      .href;
    await link.click();
    await expect(page).toHaveURL(profileUrl);
    await expect(
      page.getByRole("dialog", { name: "Volunteer profile", exact: true }),
    ).toHaveCount(0);
    const profile = page.locator("[data-volunteer-profile]");
    await expect(profile).toBeVisible();
    const profilePanel = profile.getByRole("region", {
      name: "Profile",
      exact: true,
    });
    await expect(profilePanel).toBeVisible();
    await expect(profilePanel.getByRole("heading")).toHaveText([
      "Profile",
      "Personal info",
      "Emergency contact",
      "Team interests",
      "Training and safety",
    ]);
    const controls = profile.locator(
      '[data-volunteer-profile-panel="application"] + [data-volunteer-controls]',
    );
    await expect(controls).toBeVisible();
    const applicationPanel = profile.getByRole("region", {
      name: "Application",
      exact: true,
    });
    await expect(applicationPanel).toBeVisible();
    await expect(applicationPanel.locator("details")).toHaveCount(0);
    await expect(applicationPanel.getByRole("heading")).toHaveText([
      "Application",
    ]);
    await expect(
      applicationPanel.getByRole("link", {
        name: "View application",
        exact: true,
      }),
    ).toBeVisible();
    await expect(controls).toBeVisible();
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
  await page.goto("/events");
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
        .getByRole("button", { name: "Create", exact: true })
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
          create.getByRole("button", { name: "Create", exact: true }).click(),
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
        create.getByRole("button", { name: "Create", exact: true }),
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
      name: "Remove volunteer",
    });
    await expectPinnedChrome(registration);
    await registration.locator(".dialog-close").click();
  }

  const link = page
    .locator(".volunteer-roster[open] [data-volunteer-profile-link]")
    .first();
  const profileUrl = new URL((await link.getAttribute("href"))!, page.url())
    .href;
  await link.click();
  await expect(page).toHaveURL(profileUrl);
  await expect(page.locator("[data-volunteer-profile]")).toBeVisible();
  await expect(
    page.getByRole("dialog", { name: "Volunteer profile", exact: true }),
  ).toHaveCount(0);
});
