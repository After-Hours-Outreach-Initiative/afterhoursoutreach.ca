import { expect, test, type Locator } from "@playwright/test";
import { inPlaceAction } from "../helpers/in-place-action";
import {
  approveLocalApplication,
  createLocalAccount,
  openLocalAccountSwitcher,
} from "../helpers/local-account";

test("empty volunteer rosters reserve no space through first/last signup updates", async ({
  page,
  browser,
  baseURL,
}) => {
  test.skip(
    !baseURL?.startsWith("http://localhost:"),
    "Local D1 development only",
  );
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 375, height: 900 });
  await page.goto("/volunteer");
  await (
    await openLocalAccountSwitcher(page)
  )
    .locator('[data-switch-user="local-fixture-user-robin"]')
    .click();
  await page.getByRole("link", { name: "Organizer", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Create", exact: true }),
  ).toBeVisible();
  const meetingPoint = `Stable roster ${crypto.randomUUID()}`;
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
        open: true,
        hidden: false,
      },
    },
  });
  expect(created.status(), await created.text()).toBe(200);
  await page.reload();
  const organizerCard = page
    .locator("[data-live-event]")
    .filter({ hasText: meetingPoint });
  await expect(organizerCard).toBeVisible();
  const id = await organizerCard.getAttribute("data-live-event");
  const viewerContext = await browser.newContext({
    baseURL,
    viewport: { width: 375, height: 900 },
  });
  try {
    const viewer = await viewerContext.newPage();
    const account = await createLocalAccount(viewer.request, baseURL!);
    const completed = await viewer.request.post("/api/v1/account/naloxone", {
      headers: { origin: baseURL! },
      data: { userId: account.id, completed: true },
    });
    expect(completed.status(), await completed.text()).toBe(200);
    const connected = await viewer.request.post("/api/v1/account/discord", {
      headers: { origin: baseURL! },
      data: { userId: account.id, consent: true, outcome: "authorize" },
    });
    expect(connected.status(), await connected.text()).toBe(200);
    await approveLocalApplication(page.request, baseURL!, account.id);
    await viewer.goto("/events");
    const cards = [page, viewer].map((current) =>
      current.locator(`[data-live-event="${id}"]`),
    );
    const roster = (card: Locator) =>
      card.locator(".volunteer-roster, .public-event-roster");
    const geometry = (card: Locator) =>
      card.evaluate((element) => {
        const top = element.getBoundingClientRect().top;
        return {
          height: element.getBoundingClientRect().height,
          rowHeight:
            element.querySelector(".event-avatar-row")?.getBoundingClientRect()
              .height ?? 0,
          actionTop:
            element.querySelector(".volunteer-actions")!.getBoundingClientRect()
              .top - top,
          rosterHeight:
            element
              .querySelector(".volunteer-roster, .public-event-roster")
              ?.getBoundingClientRect().height ?? 0,
        };
      });
    const initial = [];
    for (const card of cards) {
      await expect(card.locator(".event-row-label")).toHaveCount(0);
      await expect(
        card.locator(".event-avatar-row .attendee-avatar"),
      ).toHaveCount(0);
      await expect(card.locator(".event-attendance")).toHaveCount(0);
      await expect(roster(card)).toHaveCount(0);
      const before = await geometry(card);
      expect(before.rowHeight).toBe(0);
      expect(before.rosterHeight).toBe(0);
      initial.push(before);
    }
    const setRegistration = async (action: "join" | "cancel") => {
      const response = await page.request.post("/api/v1/events/action", {
        headers: { origin: baseURL! },
        data: { action, id },
      });
      expect(response.status(), await response.text()).toBe(200);
    };
    await setRegistration("join");
    for (const [index, card] of cards.entries()) {
      await expect(
        roster(card).locator("summary > span:first-child"),
      ).toHaveText("Volunteers (1)", {
        timeout: 15_000,
      });
      await expect(
        roster(card).locator("summary .event-avatar-row .attendee-avatar"),
      ).toHaveCount(1);
      await expect(
        card.locator(".volunteer-event-layout .event-attendance"),
      ).toHaveCount(0);
      await expect(roster(card)).not.toHaveAttribute("open");
      const registered = await geometry(card);
      expect(registered.rowHeight).toBe(24);
      expect(registered.height).toBeGreaterThan(initial[index].height);
      expect(registered.rosterHeight).toBeGreaterThan(0);
      expect(registered.actionTop).toBe(initial[index].actionTop);
      await card.page().emulateMedia({
        reducedMotion: index === 1 ? "reduce" : "no-preference",
      });
      await roster(card).locator("summary").focus();
      await roster(card).locator("summary").press("Enter");
      await expect(roster(card).locator("summary")).toHaveCSS(
        "border-bottom-left-radius",
        "0px",
      );
      await expect(roster(card).locator("tbody tr")).toHaveCount(1);
      const disclosure = await roster(card).evaluate((element) => {
        const summary = element.querySelector("summary")!;
        const frame = element.querySelector(".table-scroll-frame")!;
        const panel = element.querySelector("table")!;
        const triggerBounds = summary.getBoundingClientRect();
        const panelBounds = panel.getBoundingClientRect();
        return {
          gap: panelBounds.top - triggerBounds.bottom,
          sameWidth:
            frame.getBoundingClientRect().width === triggerBounds.width,
          joinedRadii: [
            getComputedStyle(summary).borderBottomLeftRadius,
            getComputedStyle(panel).borderTopLeftRadius,
          ],
          matchingBorder:
            getComputedStyle(panel).borderLeftColor ===
            getComputedStyle(summary).borderLeftColor,
          transition: getComputedStyle(element, "::details-content")
            .transitionDuration,
        };
      });
      expect(disclosure).toEqual({
        gap: 0,
        sameWidth: true,
        joinedRadii: ["0px", "0px"],
        matchingBorder: true,
        transition: index === 1 ? "0s" : "0.18s",
      });
      const registrations = roster(card).locator("time.event-roster-status");
      await expect(registrations).toHaveCount(index === 0 ? 1 : 0);
      if (index === 0) {
        const actionSpace = await roster(card)
          .locator(".event-roster-actions")
          .evaluate((cell) => {
            const button = cell.querySelector("button")!;
            const styles = getComputedStyle(cell);
            return (
              cell.getBoundingClientRect().width -
              button.getBoundingClientRect().width -
              parseFloat(styles.paddingLeft) -
              parseFloat(styles.paddingRight)
            );
          });
        expect(actionSpace).toBeLessThan(1);
        await expect(registrations.first()).toContainText("Registered ");
        await expect(registrations.first()).not.toContainText(
          /\b(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\b/,
        );
        await expect(registrations.first()).toHaveCSS("font-size", "14px");
        await expect(
          roster(card).locator(".event-roster-name a").first(),
        ).toHaveCSS("font-size", "16px");
        const registrationLayout = await roster(card)
          .locator("tbody th")
          .first()
          .evaluate((cell) => {
            const avatar = cell
              .querySelector(".attendee-avatar")!
              .getBoundingClientRect();
            const person = cell
              .querySelector(".event-roster-person")!
              .getBoundingClientRect();
            const name = cell
              .querySelector(".event-roster-name")!
              .getBoundingClientRect();
            const timestamp = cell
              .querySelector("time")!
              .getBoundingClientRect();
            return {
              nameCenterOffset:
                name.top + name.height / 2 - (avatar.top + avatar.height / 2),
              timestampBelowPerson: timestamp.top >= person.bottom,
              timestampLeftOffset: timestamp.left - avatar.left,
            };
          });
        expect(Math.abs(registrationLayout.nameCenterOffset)).toBeLessThan(1);
        expect(registrationLayout.timestampBelowPerson).toBe(true);
        expect(registrationLayout.timestampLeftOffset).toBe(0);
      }
      await expect(
        roster(card).locator("summary > span:first-child"),
      ).toHaveCSS("font-size", "14px");
      await expect(
        roster(card).getByText("No volunteers registered yet."),
      ).toHaveCount(0);
    }
    await setRegistration("cancel");
    for (const [index, card] of cards.entries()) {
      await expect(roster(card)).toHaveCount(0, { timeout: 15_000 });
      await expect(card).toBeFocused();
      await expect(
        card.locator(".event-avatar-row .attendee-avatar"),
      ).toHaveCount(0);
      expect(await geometry(card)).toEqual(initial[index]);
    }
    // Form submissions use the same server-rendered empty state as live polling.
    const publicCard = cards[1];
    for (const joining of [true, false]) {
      const button = publicCard.locator("[data-live-signup] button");
      await inPlaceAction(viewer, {
        endpoint: "/api/v1/events/action",
        form: publicCard.locator("[data-live-signup]"),
        trigger: async () => {
          await button.click();
          if (!joining)
            await viewer
              .getByRole("dialog", {
                name: "Unregister from this event?",
                exact: true,
              })
              .getByRole("button", { name: "Unregister", exact: true })
              .click();
        },
        loadingLabel: joining ? "Registering…" : "Unregistering…",
        pending: async () => {
          for (const width of [1280, 768, 375, 320]) {
            await viewer.setViewportSize({ width, height: 900 });
            expect(
              await button.evaluate((element) => {
                const range = document.createRange();
                range.selectNodeContents(element);
                return {
                  lines: range.getClientRects().length,
                  buttonOverflow: element.scrollWidth > element.clientWidth,
                  pageOverflow:
                    document.documentElement.scrollWidth > innerWidth,
                };
              }),
            ).toEqual({ lines: 1, buttonOverflow: false, pageOverflow: false });
          }
        },
        updated: async () => {
          if (joining) {
            await expect(
              roster(publicCard).locator("summary > span:first-child"),
            ).toHaveText("Volunteers (1)");
            await expect(
              roster(publicCard).locator("summary .attendee-avatar"),
            ).toHaveCount(1);
          } else await expect(roster(publicCard)).toHaveCount(0);
          await expect(button).toBeFocused();
        },
      });
    }
    await expect(
      publicCard.locator(".event-avatar-row .attendee-avatar"),
    ).toHaveCount(0);
  } finally {
    await viewerContext.close();
  }
});

test("striped roster tables share avatar sizing and organizer-only keyboard action menus", async ({
  page,
  browser,
  baseURL,
}) => {
  test.skip(
    !baseURL?.startsWith("http://localhost:"),
    "Local D1 development only",
  );
  await page.goto("/volunteer");
  await (
    await openLocalAccountSwitcher(page)
  )
    .locator('[data-switch-user="local-fixture-user-robin"]')
    .click();
  await page.getByRole("link", { name: "Organizer", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Create", exact: true }),
  ).toBeVisible();
  const meetingPoint = `Roster menus ${crypto.randomUUID()}`;
  const created = await page.request.post("/api/v1/events/action", {
    headers: { origin: baseURL! },
    data: {
      action: "save",
      event: {
        includesOrientation: false,
        startsAt: new Date(Date.now() + 86_400_000).toISOString(),
        meetingPoint,
        meetingPointUrl: "",
        spots: 8,
        open: true,
        hidden: false,
      },
    },
  });
  expect(created.status(), await created.text()).toBe(200);
  await page.reload();
  const id = await page
    .locator("[data-live-event]")
    .filter({ hasText: meetingPoint })
    .getAttribute("data-live-event");
  const joined = await page.request.post("/api/v1/events/action", {
    headers: { origin: baseURL! },
    data: { action: "join", id },
  });
  expect(joined.status(), await joined.text()).toBe(200);
  const viewerContext = await browser.newContext({ baseURL });
  try {
    const viewer = await viewerContext.newPage();
    await viewer.goto("/volunteer");
    await (
      await openLocalAccountSwitcher(viewer)
    )
      .locator('[data-switch-user="local-fixture-user-dana"]')
      .click();
    await expect(
      viewer.getByRole("button", { name: /Account for Dana/ }),
    ).toBeVisible();
    const joined = await viewer.request.post("/api/v1/events/action", {
      headers: { origin: baseURL! },
      data: { action: "join", id },
    });
    expect(joined.status(), await joined.text()).toBe(200);
    await viewer.goto("/events");

    for (const [path, width] of [
      ["/events?view=volunteer", 1280],
      ["/events", 1280],
      ["/events?view=volunteer", 320],
      ["/events", 320],
    ] as const) {
      await page.setViewportSize({ width, height: 900 });
      await viewer.setViewportSize({ width, height: 900 });
      await page.goto(path);
      for (const current of [page, viewer]) {
        const card = current.locator(`[data-live-event="${id}"]`);
        const roster = card.locator(".volunteer-roster, .public-event-roster");
        const summary = roster.locator("summary");
        if (
          !(await roster.evaluate(
            (element: HTMLDetailsElement) => element.open,
          ))
        ) {
          await expect(summary.locator(".event-roster-chevron")).toHaveCSS(
            "transform",
            "none",
          );
          await summary.click({
            position: {
              x: await summary.evaluate((element) => element.clientWidth - 20),
              y: 24,
            },
          });
        }
        await expect(
          roster.getByRole("table", { name: "Registered volunteers" }),
        ).toBeVisible();
        await expect(summary.locator(".event-roster-chevron")).toHaveCSS(
          "transform",
          "matrix(-1, 0, 0, -1, 0, 0)",
        );
        await expect(roster.locator("tbody tr")).toHaveCount(2);
        const layout = await card.evaluate((element) => {
          const rows = [...element.querySelectorAll("tbody tr")];
          const avatar = (selector: string) =>
            element.querySelector(selector)!.getBoundingClientRect().height;
          const summary = element.querySelector("details > summary")!;
          const title = summary.querySelector(":scope > span")!;
          const avatars = summary.querySelector(".event-avatar-row")!;
          const chevron = summary.querySelector(".event-roster-chevron")!;
          const summaryBounds = summary.getBoundingClientRect();
          const chevronBounds = chevron.getBoundingClientRect();
          return {
            avatars: [
              avatar(".event-avatar-row .attendee-avatar"),
              avatar(".event-roster-person .attendee-avatar"),
            ],
            stripes: rows.map((row) => getComputedStyle(row).backgroundColor),
            summaryWidth: summary.getBoundingClientRect().width,
            rosterWidth: summary.parentElement!.getBoundingClientRect().width,
            summaryHeight: summary.getBoundingClientRect().height,
            avatarsBelowTitle:
              avatars.getBoundingClientRect().top >=
              title.getBoundingClientRect().bottom,
            avatarsLeftOfChevron:
              avatars.getBoundingClientRect().right <= chevronBounds.left,
            chevronCenterOffset:
              chevronBounds.top +
              chevronBounds.height / 2 -
              (summaryBounds.top + summaryBounds.height / 2),
            rosterBorderTop: getComputedStyle(summary.parentElement!)
              .borderTopWidth,
            chevron: getComputedStyle(chevron).transform,
            overflow: document.documentElement.scrollWidth > innerWidth,
          };
        });
        expect(layout.avatars).toEqual([24, 24]);
        expect(layout.stripes).toEqual(["rgb(12, 13, 16)", "rgb(23, 26, 32)"]);
        expect(layout.summaryWidth).toBe(layout.rosterWidth);
        expect(layout.summaryHeight).toBeGreaterThanOrEqual(48);
        expect(layout.avatarsBelowTitle).toBe(layout.rosterWidth < 512);
        expect(layout.avatarsLeftOfChevron).toBe(true);
        expect(Math.abs(layout.chevronCenterOffset)).toBeLessThan(1);
        expect(layout.rosterBorderTop).toBe("0px");
        expect(layout.chevron).toBe("matrix(-1, 0, 0, -1, 0, 0)");
        expect(layout.overflow).toBe(false);
        await summary.focus();
        await summary.press("Enter");
        await expect(roster).not.toHaveAttribute("open");
        await expect(summary).toHaveCSS("outline-style", "solid");
        await summary.press("Space");
        await expect(roster).toHaveAttribute("open", "");
        if (current === viewer) {
          await expect(
            roster.locator("a, button, input, dialog, [role=menu]"),
          ).toHaveCount(0);
          await expect(roster.locator("tbody")).not.toContainText(
            /Vance|Whitfield/,
          );
        }
      }
      const card = page.locator(`[data-live-event="${id}"]`);
      if (path.includes("view=volunteer")) {
        await expect(card.locator("[data-signup-menu-trigger]")).toHaveCount(0);
        continue;
      }
      const trigger = card.locator("[data-signup-menu-trigger]").first();
      await expect(card.locator("[data-signup-menu-trigger]")).toHaveCount(2);
      await expect(trigger).toHaveText("");
      await expect(trigger).toHaveAccessibleName(/Registration actions for /);
      await expect(trigger).toHaveCSS("border-top-width", "0px");
      await trigger.focus();
      await trigger.press("ArrowDown");
      const menu = card.getByRole("menu");
      const move = menu.getByRole("menuitem", {
        name: "Move volunteer",
        exact: true,
      });
      const remove = menu.getByRole("menuitem", { name: "Remove volunteer" });
      await expect(move).toBeFocused();
      await expect(trigger).toHaveAttribute("aria-expanded", "true");
      await move.press("End");
      await expect(remove).toBeFocused();
      await remove.press("ArrowDown");
      await expect(move).toBeFocused();
      await move.press("Escape");
      await expect(menu).toBeHidden();
      await expect(trigger).toBeFocused();
      await expect(trigger).toHaveCSS("outline-style", "solid");
      expect(
        await trigger.evaluate((element) =>
          parseFloat(getComputedStyle(element).outlineWidth),
        ),
      ).toBeGreaterThan(0);
      await expect(trigger).toHaveAttribute("aria-expanded", "false");
      await trigger.press("ArrowUp");
      await expect(remove).toBeFocused();
      await remove.press("Enter");
      const dialog = page.getByRole("dialog", {
        name: "Remove volunteer",
      });
      await expect(dialog).toBeVisible();
      await expect(dialog.locator(".dialog-body")).toHaveCSS(
        "text-align",
        "left",
      );
      await expect(
        dialog.locator('label[for^="signup-remove-reason-"]'),
      ).toHaveCSS("text-align", "left");
      await expect(
        dialog.locator("select, [data-signup-move-calendar]"),
      ).toHaveCount(0);
      await expect(
        dialog.getByRole("button", { name: "Remove volunteer", exact: true }),
      ).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(trigger).toBeFocused();
      await trigger.click();
      await move.click();
      const moveDialog = page.getByRole("dialog", {
        name: "Move volunteer",
        exact: true,
      });
      await expect(
        moveDialog.getByLabel("Destination", { exact: true }),
      ).toHaveValue("");
      await expect(
        moveDialog.locator("[data-signup-move-calendar]"),
      ).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(trigger).toBeFocused();
      await trigger.click();
      await move.press("Tab");
      await expect(menu).toBeHidden();
      await trigger.click();
      await card.locator(".volunteer-event-info h3").click();
      await expect(menu).toBeHidden();
    }
    const denied = await viewer.request.post("/api/v1/events/action", {
      headers: { origin: baseURL! },
      data: { action: "manage-signup", id: "not-an-organizer", reason: "" },
    });
    expect(denied.status()).toBe(403);
  } finally {
    await viewerContext.close();
  }
});

test("move calendar and destination select stay synchronized across months and same-day events", async ({
  page,
  baseURL,
}) => {
  test.skip(
    !baseURL?.startsWith("http://localhost:"),
    "Local D1 development only",
  );
  await page.goto("/volunteer");
  await (
    await openLocalAccountSwitcher(page)
  )
    .locator('[data-switch-user="local-fixture-user-robin"]')
    .click();
  await page.getByRole("link", { name: "Organizer", exact: true }).click();
  const year = new Date().getUTCFullYear() + 1;
  const prefix = `Move calendar ${crypto.randomUUID()}`;
  const events = [
    ["source", `${year}-12-12T20:00:00Z`],
    ["same-date", `${year}-12-12T21:00:00Z`],
    ["first", `${year}-12-13T20:00:00Z`],
    ["second", `${year}-12-13T21:00:00Z`],
    ["next-month", `${year + 1}-01-10T20:00:00Z`],
  ];
  for (const [name, startsAt] of events) {
    const response = await page.request.post("/api/v1/events/action", {
      headers: { origin: baseURL! },
      data: {
        action: "save",
        event: {
          includesOrientation: false,
          startsAt,
          meetingPoint: `${prefix} ${name}`,
          meetingPointUrl: "",
          spots: 8,
          open: true,
          hidden: false,
        },
      },
    });
    expect(response.status(), await response.text()).toBe(200);
  }
  await page.reload();
  const ids: string[] = [];
  for (const [name] of events)
    ids.push(
      (await page
        .locator("[data-live-event]")
        .filter({ hasText: `${prefix} ${name}` })
        .getAttribute("data-live-event"))!,
    );
  const joined = await page.request.post("/api/v1/events/action", {
    headers: { origin: baseURL! },
    data: { action: "join", id: ids[0] },
  });
  expect(joined.status(), await joined.text()).toBe(200);
  await page.reload();
  const card = page.locator(`[data-live-event="${ids[0]}"]`);
  await card.locator(".volunteer-roster > summary").click();
  const trigger = card.locator("[data-signup-menu-trigger]");
  await trigger.click();
  await card
    .getByRole("menuitem", { name: "Move volunteer", exact: true })
    .click();
  const move = page.getByRole("dialog", {
    name: "Move volunteer",
    exact: true,
  });
  const calendar = move.locator("[data-signup-move-calendar]");
  const select = move.getByLabel("Destination", { exact: true });
  const destination = (index: number) =>
    calendar.locator(`[data-signup-destination="${ids[index]}"]`);
  await expect(calendar.locator("[data-signup-month-label]")).toHaveText(
    `December ${year}`,
  );
  await expect(calendar.locator("[data-signup-current]")).toBeDisabled();
  await expect(calendar.locator("[data-signup-current]")).toHaveAccessibleName(
    /Current event \(not selectable\)/,
  );
  await expect(
    calendar.locator("[data-signup-current] .event-calendar-circle"),
  ).toHaveCSS("background-color", "rgb(39, 39, 42)");
  expect(
    await select.evaluate(
      (element) =>
        element instanceof HTMLSelectElement && element.checkValidity(),
    ),
  ).toBe(false);
  await expect(select.locator(`option[value="${ids[0]}"]`)).toHaveCount(0);
  expect(
    await move.evaluate(
      (dialog) =>
        dialog
          .querySelector("[data-signup-move-calendar]")!
          .compareDocumentPosition(dialog.querySelector("select")!) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ),
  ).toBeTruthy();
  // The source marker is disabled, but other events on its date remain valid.
  await destination(1).click();
  await expect(select).toHaveValue(ids[1]);
  await expect(destination(1)).toHaveAttribute("aria-pressed", "true");
  await destination(2).focus();
  await destination(2).press("Enter");
  await expect(select).toHaveValue(ids[2]);
  await expect(destination(2)).toBeFocused();
  await destination(3).click();
  await expect(select).toHaveValue(ids[3]);
  await expect(destination(2)).toHaveAttribute("aria-pressed", "false");
  await select.selectOption(ids[2]);
  await expect(destination(2)).toHaveAttribute("aria-pressed", "true");
  await select.selectOption(ids[4]);
  await expect(calendar.locator("[data-signup-month-label]")).toHaveText(
    `January ${year + 1}`,
  );
  await expect(destination(4)).toHaveAttribute("aria-pressed", "true");
  await calendar.getByRole("button", { name: "Previous month" }).click();
  await expect(select).toHaveValue(ids[4]);
  await expect(calendar.locator("[data-signup-current]")).toBeDisabled();
  await calendar.getByRole("button", { name: "Next month" }).click();
  await expect(destination(4)).toHaveAttribute("aria-pressed", "true");
  await select.selectOption(ids[3]);
  await expect(calendar.locator("[data-signup-month-label]")).toHaveText(
    `December ${year}`,
  );
  await expect(destination(3)).toHaveAttribute("aria-pressed", "true");
  await move.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(trigger).toBeFocused();
  await trigger.click();
  await card
    .getByRole("menuitem", { name: "Remove volunteer", exact: true })
    .click();
  const remove = page.getByRole("dialog", {
    name: "Remove volunteer",
    exact: true,
  });
  await expect(remove.getByLabel("Reason (optional)")).toBeVisible();
  await expect(
    remove.locator("select, [name=destination], [data-signup-move-calendar]"),
  ).toHaveCount(0);
  await expect(
    remove.getByRole("button", { name: "Remove volunteer", exact: true }),
  ).toBeVisible();
  await remove.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(trigger).toBeFocused();
  for (const width of [1280, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await trigger.click();
    await card
      .getByRole("menuitem", { name: "Move volunteer", exact: true })
      .click();
    await expect(destination(3)).toHaveAttribute("aria-pressed", "true");
    expect(
      await move
        .locator(".dialog-body")
        .evaluate((body) => body.scrollWidth > body.clientWidth),
    ).toBe(false);
    await page.keyboard.press("Escape");
  }
});
