import { expect, test, type Locator } from "@playwright/test";
import { openLocalAccountSwitcher } from "../helpers/local-account";
import { fillDateInput } from "../helpers/date-input";
import { inPlaceAction } from "../helpers/in-place-action";

async function expectPinnedChrome(dialog: Locator) {
  await expect(dialog).toBeInViewport({ ratio: 1 });
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
  await page.route("**/api/v1/events/action", (route) =>
    route.fulfill({ status: 503, json: { message: "Please try again." } }),
  );

  for (const width of [1280, 320]) {
    await page.setViewportSize({ width, height: width === 320 ? 568 : 900 });
    await openLocalAccountSwitcher(page);
    const development = page.getByRole("dialog", { name: "Local development" });
    await expectPinnedChrome(development);
    await development.locator(".dialog-close").click();
    await expect(
      page.getByRole("button", { name: "Development controls", exact: true }),
    ).toBeFocused();

    const add = page.getByRole("button", { name: "Create event", exact: true });
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
        .getByRole("button", { name: "Save event" })
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
          create.getByRole("button", { name: "Save event" }).click(),
        updated: () =>
          expect(create.locator("[data-form-message]")).toHaveText(
            "Please try again.",
          ),
        loadingLabel: "Saving…",
      });
      await expect(
        create.getByRole("button", { name: "Save event" }),
      ).toBeEnabled();
      await expect(create.locator("[data-form-message]")).toBeInViewport();
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
    await card.getByRole("button", { name: "Move or remove" }).first().click();
    const registration = page.getByRole("dialog", {
      name: "Change a registration",
    });
    await expectPinnedChrome(registration);
    await registration.locator(".dialog-close").click();
  }

  await page.goto("/volunteers");
  await page.locator("[data-volunteer-profile-link]").first().click();
  const profile = page.getByRole("dialog", {
    name: "Volunteer profile",
    exact: true,
  });
  await expect(profile.locator("[data-volunteer-profile]")).toBeVisible();
  await expectPinnedChrome(profile);
  await expect(profile.locator(".dialog-footer")).toHaveCount(0);
  await profile.locator(".dialog-close").click();
});
