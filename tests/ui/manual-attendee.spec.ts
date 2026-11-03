import { expect, test, type Route } from "@playwright/test";
import { inPlaceAction } from "../helpers/in-place-action";
import { openLocalAccountSwitcher } from "../helpers/local-account";

test("inline add-volunteer forms preserve validation, previews and responsive roster updates", async ({
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
  const meetingPoint = `Manual attendees ${crypto.randomUUID()}`;
  const created = await page.request.post("/api/v1/events/action", {
    headers: { origin: baseURL! },
    data: {
      action: "save",
      event: {
        includesOrientation: true,
        startsAt: new Date(Date.now() + 86_400_000).toISOString(),
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
  await page.goto("/manage/events");
  const card = page
    .locator("[data-live-event]")
    .filter({ hasText: meetingPoint });
  const id = await card.getAttribute("data-live-event");
  const trigger = card.locator("[data-attendee-open]");
  const form = card.locator("[data-add-attendee]");
  const name = form.getByRole("textbox", { name: "Name", exact: true });
  await expect(trigger).toBeVisible();
  await expect(form).toHaveAttribute("inert", "");
  const morph = await trigger.evaluate((button) => {
    (button as HTMLButtonElement).click();
    return (
      button.parentElement!.getAnimations()[0].effect as KeyframeEffect
    ).getKeyframes();
  });
  expect(Number.parseFloat(String(morph[1].height))).toBeGreaterThan(
    Number.parseFloat(String(morph[0].height)),
  );
  expect(Number.parseFloat(String(morph[1].width))).toBeGreaterThan(
    Number.parseFloat(String(morph[0].width)),
  );
  expect(morph[0].backgroundColor).toBe(morph[1].backgroundColor);
  await expect(card.locator(".attendee-surface")).toHaveCSS(
    "background-color",
    "rgb(0, 0, 0)",
  );
  await expect(form).toBeVisible();
  await expect(name).not.toBeFocused();
  await expect(name).not.toHaveAttribute("autofocus");
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByRole("dialog", { name: "Add volunteer" })).toHaveCount(
    0,
  );
  const preview = form.locator("[data-attendee-preview]");
  const visibleEntry = preview.locator("[data-attendee-preview-medic]:visible");
  await expect(form.getByRole("checkbox")).toHaveCount(2);
  await expect(form.locator("small, .volunteer-help")).toHaveCount(0);
  await expect(form.locator("p:visible")).toHaveCount(0);
  await expect(form.locator(".volunteer-required")).toHaveText("*");
  await expect(visibleEntry.locator(".compact-person-name")).toHaveText("Name");
  const nameError = form.locator("[data-error]");
  await expect(nameError).toBeHidden();
  await name.fill("A draft name");
  await form.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(trigger).toBeFocused();
  await expect(form).toHaveAttribute("inert", "");
  await trigger.press("Enter");
  await expect(form).toBeFocused();
  await expect(name).toHaveValue("A draft name");
  await form.press("Escape");
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  await expect(trigger).toBeFocused();
  await trigger.click();
  let actionRequests = 0;
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      new URL(request.url()).pathname === "/api/v1/events/action"
    )
      actionRequests++;
  });
  for (const name of ["", "   "]) {
    await form.getByRole("textbox", { name: "Name", exact: true }).fill(name);
    await form.getByRole("button", { name: "Add", exact: true }).click();
    await expect(nameError).toBeVisible();
    await expect(nameError).toHaveText("Enter a name.");
    await expect(
      form.getByRole("textbox", { name: "Name", exact: true }),
    ).toBeFocused();
    expect(actionRequests).toBe(0);
  }
  await form
    .getByRole("textbox", { name: "Name", exact: true })
    .fill("Avery Example");
  await expect(nameError).toBeHidden();
  await expect(visibleEntry.locator(".compact-person-name")).toHaveText(
    "Avery E.",
  );
  for (const [medic, isNew, category] of [
    [false, false, "outreach-volunteer"],
    [true, false, "medic"],
    [false, true, "new-volunteer"],
    [true, true, "new-volunteer"],
  ] as const) {
    await form
      .getByRole("checkbox", { name: "Medic", exact: true })
      .setChecked(medic);
    await form
      .getByRole("checkbox", { name: "New", exact: true })
      .setChecked(isNew);
    await expect(visibleEntry).toHaveCount(1);
    await expect(visibleEntry.locator(".attendee-avatar")).toHaveClass(
      `attendee-avatar attendee-${category}`,
    );
    await expect(
      visibleEntry.locator('[data-avatar-decoration="medic-cross"]'),
    ).toHaveCount(Number(medic));
    await expect(visibleEntry.locator(".event-roster-new-badge")).toHaveCount(
      Number(isNew),
    );
  }
  await form
    .getByRole("textbox", { name: "Name", exact: true })
    .fill("Averyaveryaveryaveryavery Example");
  await expect(
    visibleEntry.locator(".compact-person-name > span").first(),
  ).toContainText("… E.");
  await form
    .getByRole("textbox", { name: "Name", exact: true })
    .fill("Avery Example");
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
    route.fulfill({
      status: 409,
      json: { message: "Try adding the volunteer again." },
    });
  await page.route("**/api/v1/events/action", fail);
  await form.getByRole("button", { name: "Add", exact: true }).click();
  await expect(form.getByRole("alert")).toHaveText(
    "Try adding the volunteer again.",
  );
  await expect(name).toBeEnabled();
  await expect(name).toHaveValue("Avery Example");
  await page.unroute("**/api/v1/events/action", fail);
  await inPlaceAction(page, {
    endpoint: "/api/v1/events/action",
    form,
    loadingLabel: "Adding…",
    trigger: () =>
      form.getByRole("button", { name: "Add", exact: true }).click(),
    pending: async () => {
      await expect(form.getByRole("textbox")).toBeDisabled();
      await expect(
        form.getByRole("checkbox", { name: "Medic", exact: true }),
      ).toBeDisabled();
      await expect(
        form.getByRole("button", { name: "Cancel", exact: true }),
      ).toBeDisabled();
      await form.press("Escape");
      await expect(trigger).toHaveAttribute("aria-expanded", "true");
    },
    updated: async () => {
      await expect(form).not.toBeVisible();
      await expect(trigger).toBeFocused();
      await expect(card.locator("[data-event-availability]")).toContainText(
        "1 of 8 spots taken",
      );
    },
  });
  const roster = card.locator(".volunteer-roster");
  const addVolunteer = card.getByRole("button", {
    name: "Add volunteer",
    exact: true,
  });
  await expect(addVolunteer).toHaveCount(1);
  await expect(
    card
      .locator(".volunteer-actions")
      .getByRole("button", { name: "Add volunteer", exact: true }),
  ).toHaveCount(0);
  await expect(
    card
      .locator(".volunteer-roster + .volunteer-roster-add")
      .getByRole("button", { name: "Add volunteer", exact: true }),
  ).toBeVisible();
  for (const reloaded of [false, true]) {
    if (reloaded) await page.reload();
    for (const width of [1280, 1024, 820, 768, 390, 375, 320]) {
      await page.setViewportSize({ width, height: 900 });
      for (const expanded of [false, true]) {
        await roster.evaluate((element, open) => {
          (element as HTMLDetailsElement).open = open;
        }, expanded);
        const layout = await addVolunteer.evaluate((button) => {
          const roster = button
            .closest("[data-live-event]")!
            .querySelector(".volunteer-roster")!;
          const eventLayout = roster.previousElementSibling!;
          const bounds = button.parentElement!.getBoundingClientRect();
          const rosterBounds = roster.getBoundingClientRect();
          return {
            gap: bounds.top - rosterBounds.bottom,
            gapAboveRoster:
              rosterBounds.top - eventLayout.getBoundingClientRect().bottom,
            buttonGap: parseFloat(
              getComputedStyle(eventLayout.querySelector(".volunteer-actions")!)
                .rowGap,
            ),
            buttonWidth: bounds.width,
            rosterWidth: rosterBounds.width,
            left: bounds.left - rosterBounds.left,
            right: rosterBounds.right - bounds.right,
            rem: parseFloat(
              getComputedStyle(document.documentElement).fontSize,
            ),
          };
        });
        expect(
          layout.gap,
          JSON.stringify({ width, expanded, reloaded, ...layout }),
        ).toBeCloseTo(layout.rem, 1);
        expect(layout.gapAboveRoster).toBeCloseTo(layout.rem, 1);
        expect(layout.buttonGap).toBeCloseTo(layout.rem, 1);
        expect(layout.left).toBeCloseTo(0, 1);
        if (width < 64 * layout.rem || layout.rosterWidth < 32 * layout.rem) {
          expect(layout.buttonWidth).toBeCloseTo(layout.rosterWidth, 1);
          expect(layout.right).toBeCloseTo(0, 1);
        }
      }
    }
  }
  await page.emulateMedia({ reducedMotion: "reduce" });
  await addVolunteer.click();
  await expect(form).toBeVisible();
  await expect(name).not.toBeFocused();
  expect(
    await card
      .locator(".attendee-surface")
      .evaluate((surface) => surface.getAnimations().length),
  ).toBe(0);
  await form.press("Escape");
  await expect(addVolunteer).toBeFocused();
  await page.emulateMedia({ reducedMotion: "no-preference" });
  const row = roster.locator("tbody > tr").filter({ hasText: "Avery E." });
  await expect(row).toHaveCount(1);
  await expect(row.locator("time.event-roster-status")).toHaveText(
    /^Manually added [^·]/,
  );
  await expect(
    row.locator(
      ".attendee-new-volunteer [data-avatar-decoration='medic-cross']",
    ),
  ).toHaveCount(1);
  await expect(row.locator(".event-roster-new-badge")).toHaveText("New");
  await expect(row.locator("a, [data-organizer-orientation]")).toHaveCount(0);

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
      publicCard.getByRole("button", { name: "Add volunteer", exact: true }),
    ).toHaveCount(0);
    await publicCard.locator(".public-event-roster summary").click();
    await expect(publicCard.locator("tbody .compact-person-name")).toHaveText(
      "Avery E.",
    );
    await expect(publicCard.locator("time.event-roster-status")).toHaveCount(0);
    await expect(publicCard.getByText(/Manually added/)).toHaveCount(0);
    const publicSpacing = await publicCard.evaluate((card) => {
      const roster = card.querySelector(".public-event-roster")!;
      const layout = card.querySelector(".volunteer-event-layout")!;
      return {
        gap:
          roster.getBoundingClientRect().top -
          layout.getBoundingClientRect().bottom,
        rem: parseFloat(getComputedStyle(document.documentElement).fontSize),
      };
    });
    expect(publicSpacing.gap).toBeCloseTo(publicSpacing.rem, 1);
    const denied = await viewer.request.post("/api/v1/events/action", {
      headers: { origin: baseURL! },
      data: {
        action: "add-attendee",
        id,
        name: "Denied",
        medic: false,
        newVolunteer: false,
      },
    });
    expect(denied.status()).toBe(403);
    await row
      .getByRole("button", {
        name: "Registration actions for Avery E.",
        exact: true,
      })
      .click();
    await page
      .getByRole("menuitem", { name: "Remove volunteer", exact: true })
      .click();
    const remove = page.getByRole("dialog", {
      name: "Remove volunteer",
      exact: true,
    });
    await expect(
      remove.locator("[data-email-prompt], textarea, .volunteer-help"),
    ).toHaveCount(0);
    await inPlaceAction(page, {
      endpoint: "/api/v1/events/action",
      form: remove.locator("form"),
      loadingLabel: "Removing…",
      trigger: () =>
        remove
          .getByRole("button", { name: "Remove volunteer", exact: true })
          .click(),
      updated: async () => {
        await expect(card.locator(".volunteer-roster")).toHaveCount(0);
        await expect(
          card.getByRole("button", { name: "Add volunteer", exact: true }),
        ).toBeVisible();
        await expect(card.locator("[data-event-availability]")).toContainText(
          "0 of 8 spots taken",
        );
      },
    });
    await expect(publicCard.locator(".public-event-roster")).toHaveCount(0, {
      timeout: 15_000,
    });
  } finally {
    await viewerContext.close();
  }
});
