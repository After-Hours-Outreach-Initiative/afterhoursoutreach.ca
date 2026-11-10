import { expect, test, type Route } from "@playwright/test";
import { formatEventDate } from "../../src/data/event-time";
import { inPlaceAction } from "../helpers/in-place-action";
import { openLocalAccountSwitcher } from "../helpers/local-account";

test("staged volunteer additions support keyboard search, manual roles, errors and roster updates", async ({
  page,
  browser,
  baseURL,
}) => {
  test.skip(
    !baseURL?.startsWith("http://localhost:"),
    "Local D1 development only",
  );
  test.setTimeout(90_000);
  await page.goto("/volunteer");
  await (
    await openLocalAccountSwitcher(page)
  )
    .locator('[data-switch-user="local-fixture-user-robin"]')
    .click();
  await expect(
    page.getByRole("button", { name: "Create", exact: true }),
  ).toBeVisible();
  const meetingPoint = `Staged attendees ${crypto.randomUUID()}`;
  const startsAt = Date.now() + 86_400_000;
  const created = await page.request.post("/api/v1/events/action", {
    headers: { origin: baseURL! },
    data: {
      action: "save",
      event: {
        includesOrientation: true,
        startsAt: new Date(startsAt).toISOString(),
        meetingPoint,
        meetingPointUrl: "",
        spots: 8,
        minMedicSpots: 0,
        minNewVolunteerSpots: 0,
        maxNewVolunteers: 8,
        open: true,
        hidden: false,
      },
    },
  });
  expect(created.status(), await created.text()).toBe(200);
  await page.goto("/events");
  const card = page
    .locator("[data-live-event]")
    .filter({ hasText: meetingPoint });
  const id = await card.getAttribute("data-live-event");
  const trigger = card.getByRole("button", {
    name: "Add volunteers",
    exact: true,
  });
  const form = card.locator("[data-add-attendee]");
  const search = form.getByRole("combobox", { name: "Search volunteers" });
  const searchMessage = form.locator("[data-search-message]");
  const searchErrorIcon = form.locator(
    ".attendee-message:has(> [data-search-message]) > svg",
  );
  const formErrorIcon = form.locator(
    ".attendee-message:has(> [data-form-message]) > svg",
  );
  const staged = form.getByRole("list", { name: "Volunteers to add" });
  const addManual = form.getByRole("button", {
    name: "Add volunteer manually",
  });
  await page.setViewportSize({ width: 375, height: 600 });
  await expect(form).toHaveAttribute("inert", "");
  await trigger.evaluate((element) =>
    element.scrollIntoView({ block: "end", behavior: "instant" }),
  );
  // Expansion must preserve the scroll position immediately and after animation.
  expect(
    await trigger.evaluate(async (element) => {
      const before = scrollY;
      (element as HTMLButtonElement).click();
      const surface = element.closest(".attendee-surface")!;
      const immediate = scrollY - before;
      await Promise.all(
        surface.getAnimations().map((animation) => animation.finished),
      );
      return { immediate, finished: scrollY - before };
    }),
  ).toEqual({ immediate: 0, finished: 0 });
  await expect(form).toHaveAccessibleName("Add volunteers");
  await expect(form).toBeFocused();
  await expect(search).not.toBeFocused();
  await expect(search).toHaveAttribute("placeholder", "Search by name");
  await expect(form.locator(".volunteer-search-icon")).toBeVisible();
  await expect(form.locator('label[for$="-search"] > span')).toHaveClass(
    "sr-only",
  );
  await page.setViewportSize({ width: 1280, height: 900 });
  await expect(form.getByText("Preview", { exact: true })).toHaveCount(0);
  await expect(formErrorIcon).toBeHidden();
  await expect(searchErrorIcon).toBeHidden();
  await form.getByRole("button", { name: "Add", exact: true }).click();
  await expect(form.getByRole("alert")).toHaveText(
    "Choose a volunteer or enter a name.",
  );
  await expect(formErrorIcon).toBeVisible();
  await expect(formErrorIcon).toHaveAttribute("aria-hidden", "true");

  const failSearch = (route: Route) =>
    route.fulfill({
      status: 503,
      json: { message: "Volunteers could not be found. Try again." },
    });
  await page.route("**/api/v1/events/volunteers?*", failSearch);
  await search.fill("Robin");
  await expect(searchMessage).toHaveText(
    "Volunteers could not be found. Try again.",
  );
  await expect(searchMessage).toHaveAttribute("role", "alert");
  await expect(searchErrorIcon).toBeVisible();
  await expect(searchErrorIcon).toHaveAttribute("aria-hidden", "true");
  await page.unroute("**/api/v1/events/volunteers?*", failSearch);

  await search.fill("a");
  const options = form.getByRole("option");
  await expect.poll(() => options.count()).toBeGreaterThan(1);
  await expect(searchMessage).toHaveAttribute("role", "status");
  await expect(searchErrorIcon).toBeHidden();
  const first = await search.getAttribute("aria-activedescendant");
  await search.press("ArrowDown");
  const second = await search.getAttribute("aria-activedescendant");
  expect(second).not.toBe(first);
  await search.press("ArrowUp");
  await expect(search).toHaveAttribute("aria-activedescendant", first!);
  await search.press("Tab");
  await expect(search).toBeFocused();
  await expect(search).toHaveAttribute("aria-activedescendant", second!);
  await search.press("Shift+Tab");
  await expect(search).toHaveAttribute("aria-activedescendant", first!);
  await search.press("Escape");
  await expect(search).toHaveAttribute("aria-expanded", "false");
  await expect(form).toBeVisible();
  await search.fill("Robin");
  const robin = options.filter({ hasText: "Robin V." });
  await expect(robin).toHaveCount(1);
  await expect(robin.locator(".attendee-avatar")).toBeVisible();
  await expect(robin.locator('[data-volunteer-role="organizer"]')).toHaveText(
    "Organizer",
  );
  await search.press("Enter");
  await expect(search).toHaveValue("");
  await expect(search).toBeFocused();
  await expect(staged.locator("[data-staged-row]")).toHaveCount(1);
  await expect(staged.locator('[data-volunteer-role="organizer"]')).toHaveText(
    "Organizer",
  );
  await search.fill("Robin");
  await expect(form.locator("[data-search-message]")).toContainText(
    "No matching eligible volunteers",
  );
  await expect(searchErrorIcon).toBeHidden();
  await expect(options).toHaveCount(0);
  await search.fill("");
  await expect(addManual.locator("svg.btn-icon")).toHaveAttribute(
    "aria-hidden",
    "true",
  );
  await addManual.click();
  const name = staged
    .getByRole("textbox", { name: "Name", exact: true })
    .first();
  await expect(name).toBeFocused();
  await name.pressSequentially("Avery Example");
  await expect(name).toHaveValue("Avery Example");
  await expect(name).toBeFocused();
  const manualRow = name.locator("xpath=ancestor::li[1]");
  const medic = manualRow.getByRole("checkbox", { name: "Medic", exact: true });
  const newVolunteer = manualRow.getByRole("checkbox", {
    name: "New",
    exact: true,
  });
  await expect(medic).not.toBeChecked();
  await expect(newVolunteer).not.toBeChecked();
  await expect(medic).toHaveAttribute("name", "medic");
  await expect(newVolunteer).toHaveAttribute("name", "newVolunteer");
  const medicId = await medic.getAttribute("id");
  const newVolunteerId = await newVolunteer.getAttribute("id");
  expect(medicId).toBeTruthy();
  expect(newVolunteerId).not.toBe(medicId);
  // Click the badge text/padding, not just its checkbox.
  await manualRow.locator('[data-volunteer-role="medic"]').click({
    position: { x: 60, y: 12 },
  });
  await expect(medic).toBeChecked();
  await expect(medic).toBeFocused();
  await medic.press("Space");
  await expect(medic).not.toBeChecked();
  await medic.press("Space");
  await manualRow.locator('[data-volunteer-role="new-volunteer"]').click({
    position: { x: 50, y: 12 },
  });
  await expect(newVolunteer).toBeChecked();
  await expect(newVolunteer).toBeFocused();
  await expect(staged.locator(".event-roster-new-badge")).toHaveText("New");
  await expect(
    staged.locator('[data-avatar-decoration="medic-cross"]'),
  ).toHaveCount(1);
  await addManual.click();
  await staged
    .getByRole("textbox", { name: "Name", exact: true })
    .last()
    .fill("Discard me");
  await staged
    .getByRole("button", { name: "Remove Discard me from list" })
    .click();
  await expect(search).not.toBeFocused();
  await expect(
    staged.getByRole("button", { name: "Remove Avery Example from list" }),
  ).toBeFocused();
  await addManual.click();
  await staged
    .getByRole("textbox", { name: "Name", exact: true })
    .last()
    .fill("   ");
  await form.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(trigger).toBeFocused();
  await page.setViewportSize({ width: 320, height: 480 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  const scrollBeforeExpansion = await page.evaluate(() => scrollY);
  await trigger.press("Enter");
  await expect(form).toBeFocused();
  await expect(search).not.toBeFocused();
  expect(await page.evaluate(() => scrollY)).toBe(scrollBeforeExpansion);
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await expect(name).toHaveValue("Avery Example");
  await expect(medic).toBeChecked();
  await expect(newVolunteer).toBeChecked();
  for (const width of [1280, 375, 320]) {
    await page.setViewportSize({ width, height: 900 });
    expect(
      await form.evaluate((element) => ({
        form: element.scrollWidth > element.clientWidth,
        page: document.documentElement.scrollWidth > innerWidth,
      })),
    ).toEqual({ form: false, page: false });
  }
  const fail = (route: Route) =>
    route.fulfill({ status: 409, json: { message: "This event is full." } });
  await page.route("**/api/v1/events/action", fail);
  await form.getByRole("button", { name: "Add", exact: true }).click();
  await expect(form.getByRole("alert")).toHaveText("This event is full.");
  await expect(formErrorIcon).toBeVisible();
  await expect(name).toBeEnabled();
  await expect(name).toHaveValue("Avery Example");
  await expect(staged.locator("[data-staged-row]")).toHaveCount(3);
  await page.unroute("**/api/v1/events/action", fail);
  await inPlaceAction(page, {
    endpoint: "/api/v1/events/action",
    form,
    loadingLabel: "Adding…",
    trigger: () =>
      form.getByRole("button", { name: "Add", exact: true }).click(),
    pending: async () => {
      await expect(formErrorIcon).toBeHidden();
      await expect(searchErrorIcon).toBeHidden();
      await expect(name).toBeDisabled();
      await expect(medic).toBeDisabled();
      await expect(newVolunteer).toBeDisabled();
      await expect(addManual).toBeDisabled();
      await form.press("Escape");
      await expect(form).toBeVisible();
    },
    updated: async () => {
      await expect(form).not.toBeVisible();
      await expect(trigger).toBeFocused();
      await expect(card.locator("[data-event-availability]")).toHaveText(
        "Registered · 6 of 8 spots remaining",
      );
    },
  });
  const roster = card.locator(".volunteer-roster");
  await roster.locator("summary").click();
  await expect(roster.locator(".event-roster-list > li")).toHaveCount(2);
  const row = roster
    .locator(".event-roster-list > li")
    .filter({ hasText: "Avery E." });
  await expect(row.locator(".event-roster-new-badge")).toHaveText("New");
  for (const width of [1280, 320]) {
    await page.setViewportSize({ width, height: 900 });
    const status = row.locator(".event-roster-status").first();
    const organizer = status.getByRole("link", { name: "Robin V." });
    if (width === 1280) {
      await expect(status).toHaveText(/^Added by Robin V\. on /);
      await expect(organizer).toHaveAttribute(
        "href",
        "/volunteers/local-fixture-user-robin",
      );
    } else {
      await expect(organizer).toBeHidden();
      expect((await status.innerText()).trim()).toBe(
        await status.locator("time").innerText(),
      );
    }
    await row.locator("[data-signup-menu-trigger]").focus();
    await page.keyboard.press("ArrowDown");
    const addedBy = row.getByRole("menuitem", { name: "Added by Robin V." });
    await expect(addedBy).toBeFocused();
    await addedBy.press("ArrowDown");
    await expect(
      row.getByRole("menuitem", { name: "Move volunteer", exact: true }),
    ).toBeFocused();
    await page.keyboard.press("Escape");
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  const accountRow = roster.locator(".event-roster-list > li").filter({
    has: page.locator(
      '.event-roster-name a[href="/volunteers/local-fixture-user-robin"]',
    ),
  });
  await expect(accountRow.locator(".event-roster-status").first()).toHaveText(
    /^Added by Robin V\. on /,
  );
  await trigger.click();
  await search.fill("Robin");
  await expect(form.locator("[data-search-message]")).toContainText(
    "No matching eligible volunteers",
  );
  await form.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(form).toHaveAttribute("aria-hidden", "true");
  await expect(trigger).toBeFocused();

  const viewerContext = await browser.newContext({ baseURL });
  try {
    const viewer = await viewerContext.newPage();
    await viewer.goto("/volunteer");
    await (
      await openLocalAccountSwitcher(viewer)
    )
      .locator('[data-switch-user="local-fixture-user-dana"]')
      .click();
    await expect(viewer).toHaveURL(/\/events\/?$/);
    const publicCard = viewer.locator(`[data-live-event="${id}"]`);
    await expect(
      publicCard.getByRole("button", { name: "Add volunteers", exact: true }),
    ).toHaveCount(0);
    await publicCard.locator(".public-event-roster summary").click();
    await expect(
      publicCard.locator(".event-roster-list .compact-person-name"),
    ).toHaveCount(2);
    await expect(publicCard.getByText(/Added by/)).toHaveCount(0);
    const searchDenied = await viewer.request.get(
      `/api/v1/events/volunteers?id=${encodeURIComponent(id!)}&q=Robin`,
    );
    expect(searchDenied.status()).toBe(403);
    expect(await searchDenied.text()).not.toContain("Robin");
    const denied = await viewer.request.post("/api/v1/events/action", {
      headers: { origin: baseURL! },
      data: {
        action: "add-volunteers",
        id,
        volunteers: [{ name: "Denied", medic: false, newVolunteer: false }],
      },
    });
    expect(denied.status()).toBe(403);
    await row.locator("[data-signup-menu-trigger]").click();
    await row
      .getByRole("menuitem", { name: "Remove volunteer", exact: true })
      .click();
    const remove = page.getByRole("dialog", {
      name: "Remove volunteer",
      exact: true,
    });
    await expect(remove.locator(".dialog-body > p")).toHaveText(
      `Remove Avery Example from event on ${formatEventDate(startsAt)}?`,
    );
    await expect(
      remove.locator("[data-email-prompt], textarea, .volunteer-help"),
    ).toHaveCount(0);
    await inPlaceAction(page, {
      endpoint: "/api/v1/events/action",
      form: remove.locator("form"),
      loadingLabel: "Removing…",
      trigger: () =>
        remove.getByRole("button", { name: "Remove", exact: true }).click(),
      updated: async () => {
        await expect(row).toHaveCount(0);
        await expect(card.locator("[data-event-availability]")).toHaveText(
          "Registered · 7 of 8 spots remaining",
        );
      },
    });
    await expect(
      publicCard.locator(".event-roster-list .compact-person-name"),
    ).toHaveCount(1, { timeout: 15_000 });
  } finally {
    await viewerContext.close();
  }
});
