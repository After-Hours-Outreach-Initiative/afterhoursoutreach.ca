import { expect, test } from "@playwright/test";
import {
  addCalendarDays,
  formatEventDate,
  vancouverInput,
  vancouverInstant,
} from "../../src/data/event-time";
import { social } from "../../src/data/site";
import {
  createLocalAccount,
  openLocalAccountSwitcher,
  sampleAnswers,
} from "../helpers/local-account";
import { totpFromSetupKey } from "../helpers/totp";

test.use({
  extraHTTPHeaders: async ({}, use) => {
    // Isolate both browser and API requests from other tests' IP budgets.
    const ip = crypto.getRandomValues(new Uint8Array(2));
    await use({ "cf-connecting-ip": `198.18.${ip[0]}.${ip[1]}` });
  },
});

test.beforeEach(async ({ page, baseURL }) => {
  test.skip(
    !baseURL?.startsWith("http://localhost:"),
    "Local D1 development only",
  );
  await page.goto("/volunteer");
});

for (const width of [1280, 375, 320]) {
  test(`signed-out volunteer page hides events and keeps sign-in below navigation at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 812 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    const expectCardBelowNavigation = async () => {
      await expect
        .poll(async () => {
          const [card, header] = await Promise.all([
            page.locator("#volunteer-signin").boundingBox(),
            page.locator("header").boundingBox(),
          ]);
          if (!card || !header) return -1;
          return card.y - (header.y + header.height);
        })
        .toBeGreaterThanOrEqual(16);
    };
    await expect(
      page.locator("[data-live-event], [data-event-list]"),
    ).toHaveCount(0);
    await expectCardBelowNavigation();

    await page.reload();
    await expectCardBelowNavigation();
  });
}

test("volunteer-page sign-in is usable on mobile and opens the shared code form", async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 812 });
  const emails: string[] = [];
  await page.route(
    "**/api/v1/auth/email-otp/send-verification-otp**",
    (route) => {
      emails.push(route.request().postDataJSON().email);
      return route.fulfill({ json: { success: true } });
    },
  );
  await page
    .getByRole("textbox", { name: "Email", exact: true })
    .fill("mobile@example.org");
  await page.getByRole("button", { name: "Continue with Email" }).click();
  await page
    .getByRole("button", { name: "Simulate successful delivery" })
    .click();
  await expect(page.getByLabel("Six-digit code")).toBeVisible();
  await expect(page.getByLabel("Six-digit code")).toBeFocused();
  expect(emails).toEqual(["mobile@example.org"]);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
  ).toBe(false);
});

test("event filters include orientation without excluding other patrols, preserve deep links, and never submit a confirmation form", async ({
  page,
}) => {
  await (
    await openLocalAccountSwitcher(page)
  )
    .locator('[data-switch-user="local-fixture-user-casey"]')
    .click();
  await expect(page.locator("[data-event-list]")).toBeVisible();
  const documents: string[] = [];
  page.on("request", (request) => {
    if (request.resourceType() === "document") documents.push(request.url());
  });
  const cards = page.locator("[data-live-event]");
  const types = await cards.evaluateAll((nodes) =>
    nodes.map((node) => (node as HTMLElement).dataset.includesOrientation),
  );
  // Polling may add events from another test/viewer while this filter is active.
  // Verify every current card's visibility, not a stale initial list length.
  const expectFilter = (type: string) =>
    expect
      .poll(() =>
        cards.evaluateAll(
          (nodes, selected) =>
            nodes.every((node) => {
              const card = node as HTMLElement;
              return (
                card.hidden ===
                (selected === "orientation" &&
                  card.dataset.includesOrientation !== "true")
              );
            }),
          type,
        ),
      )
      .toBe(true);
  const filters = page.getByRole("group", { name: "Filter events" });
  expect(types).toContain("true");
  expect(types).toContain("false");
  const response = await page.request.get("/api/v1/events");
  expect(response.ok()).toBe(true);
  const { events } = await response.json();
  for (const event of events) {
    const card = page.locator(`[data-live-event="${event.id}"]`);
    await expect(card.getByRole("heading", { level: 3 })).toHaveText(
      formatEventDate(event.startsAt),
    );
    await expect(card.locator("h3 + p")).toHaveText(
      event.includesOrientation ? "Orientation + Patrol" : "Patrol",
    );
  }
  await filters
    .getByRole("button", { name: "Orientations", exact: true })
    .click();
  await expect(
    filters.getByRole("button", { name: "Orientations", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expectFilter("orientation");
  await expect(page).toHaveURL(/\?type=orientation$/);
  await filters.getByRole("button", { name: "All", exact: true }).click();
  await expectFilter("all");
  await page.goBack();
  await expect(
    filters.getByRole("button", { name: "Orientations", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expectFilter("orientation");
  expect(documents).toEqual([]);
  await page.reload();
  await expectFilter("orientation");
  await filters.getByRole("button", { name: "All", exact: true }).click();
  await expectFilter("all");
});

test("event calendar links visible cards, reaches later weeks, and survives live event changes", async ({
  page,
  baseURL,
}) => {
  test.setTimeout(45_000);
  await (
    await openLocalAccountSwitcher(page)
  )
    .locator('[data-switch-user="local-fixture-user-robin"]')
    .click();
  await page.getByRole("link", { name: "Manage events", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Create", exact: true }),
  ).toBeVisible();
  await expect(page.locator("[data-event-calendar]")).toHaveCount(0);
  const today = vancouverInput(Date.now()).slice(0, 10);
  const date = addCalendarDays(today, 2);
  const makeEvent = async (
    day: string,
    time: string,
    includesOrientation: boolean,
  ) => {
    const event = {
      includesOrientation,
      startsAt: vancouverInstant(`${day}T${time}`),
      meetingPoint: `Calendar ${crypto.randomUUID()}`,
      meetingPointUrl: "",
      spots: 10,
      open: true,
      hidden: false,
    };
    const response = await page.request.post("/api/v1/events/action", {
      headers: { origin: baseURL! },
      data: { action: "save", event },
    });
    expect(response.status(), await response.text()).toBe(200);
    const listed = await page.request.get("/api/v1/events");
    const { events } = await listed.json();
    const created = events.find(
      (item: { meetingPoint: string }) =>
        item.meetingPoint === event.meetingPoint,
    );
    expect(created).toBeDefined();
    return { id: created.id as string, event };
  };
  const patrol = await makeEvent(date, "18:00", false);
  const orientation = await makeEvent(date, "19:00", true);
  const distant = await makeEvent(addCalendarDays(today, 49), "20:00", true);
  await page.goto(`/events?occurrence=${orientation.id}`);
  const documents: string[] = [];
  page.on("request", (request) => {
    if (request.resourceType() === "document") documents.push(request.url());
  });
  const calendar = page.locator("[data-event-calendar]");
  const link = (id: string) =>
    calendar.locator(`[data-calendar-event="${id}"]`);
  const card = (id: string) => page.locator(`[data-live-event="${id}"]`);
  await expect(calendar.locator("tbody tr")).toHaveCount(5);
  await expect(calendar.locator("td")).toHaveCount(35);
  await expect(calendar.locator("th")).toHaveText([
    "S",
    "M",
    "T",
    "W",
    "T",
    "F",
    "S",
  ]);
  await expect(
    calendar.getByRole("columnheader", { name: "Thursday", exact: true }),
  ).toHaveCount(1);
  await expect(calendar.getByRole("heading")).toHaveCount(0);
  await expect(calendar).toHaveCSS("position", "sticky");
  expect(
    await calendar.evaluate(
      (element) =>
        element
          .querySelector("[data-calendar-controls]")!
          .getBoundingClientRect().top >=
        element.querySelector("table")!.getBoundingClientRect().bottom,
    ),
  ).toBe(true);
  await expect(
    calendar.locator(`[data-calendar-date="${date}"] a`),
  ).toHaveCount(2);
  await expect(
    calendar.locator(`[data-calendar-date="${date}"] .event-calendar-circle`),
  ).toHaveCount(1);
  await expect(link(patrol.id)).toHaveAccessibleName(
    new RegExp(patrol.event.meetingPoint),
  );
  await expect(
    calendar.locator("td:not(:has(a))").first().locator("a"),
  ).toHaveCount(0);
  await card(orientation.id).evaluate((element: HTMLElement) => {
    element.addEventListener("animationstart", (event) => {
      if (event.target !== element) return;
      const bounds = element.getBoundingClientRect();
      const header = document.querySelector("header")!.getBoundingClientRect();
      element.dataset.highlightStartedInView = String(
        bounds.top >= header.bottom - 1 && bounds.top < innerHeight,
      );
    });
  });
  await link(orientation.id).focus();
  await page.keyboard.press("Enter");
  await expect(card(orientation.id)).toBeFocused();
  await expect(card(orientation.id)).toBeInViewport();
  await expect(card(orientation.id)).toHaveAttribute(
    "data-calendar-highlight",
    "",
  );
  expect(
    await card(orientation.id).evaluate(
      (element) => getComputedStyle(element).animationName,
    ),
  ).not.toBe("none");
  await expect(card(orientation.id)).toHaveAttribute(
    "data-highlight-started-in-view",
    "true",
  );
  expect(
    await calendar.evaluate((element) => {
      const gap =
        element.getBoundingClientRect().top -
        document.querySelector("header")!.getBoundingClientRect().bottom;
      return gap;
    }),
  ).toBeGreaterThanOrEqual(15);
  await expect(page).toHaveURL(
    new RegExp(`occurrence=${orientation.id}#event-${orientation.id}$`),
  );
  await expect(card(orientation.id)).not.toHaveAttribute(
    "data-calendar-highlight",
    "",
  );

  await page.getByRole("button", { name: "Orientations", exact: true }).click();
  await expect(link(patrol.id)).toHaveCount(0);
  await expect(link(orientation.id)).toBeVisible();
  // Every date/event link must still target a real, visible card after filtering.
  expect(
    await calendar.locator("a").evaluateAll((links) =>
      links.every((link) => {
        const card = document.getElementById(
          (link as HTMLAnchorElement).hash.slice(1),
        );
        return card && !card.hidden;
      }),
    ),
  ).toBe(true);
  await page.goBack();
  await expect(link(patrol.id)).toBeVisible();
  await page.goForward();
  await expect(link(patrol.id)).toHaveCount(0);

  for (const width of [768, 375, 320]) {
    await page.setViewportSize({ width, height: 812 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await expect(calendar).toHaveCSS("position", "static");
    const [calendarBounds, resultsBounds] = await Promise.all([
      calendar.boundingBox(),
      page.locator(".volunteer-event-results").boundingBox(),
    ]);
    expect(calendarBounds!.width).toBeCloseTo(
      Math.min(352, resultsBounds!.width),
      0,
    );
    expect(calendarBounds!.x + calendarBounds!.width / 2).toBeCloseTo(
      resultsBounds!.x + resultsBounds!.width / 2,
      0,
    );
    expect(calendarBounds!.y + calendarBounds!.height).toBeLessThan(
      resultsBounds!.y,
    );
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
    ).toBe(false);
    await link(orientation.id).click();
    await expect(card(orientation.id)).toBeFocused();
    await expect(card(orientation.id)).toBeInViewport();
    expect(
      await card(orientation.id).evaluate(
        (element) => getComputedStyle(element).animationName,
      ),
    ).toBe("none");
    await expect(card(orientation.id)).toHaveCSS("outline-style", "solid");
  }

  // Paging changes only the calendar, even when it is above the viewport.
  expect(
    await calendar.evaluate((element) => {
      const before = scrollY;
      element
        .querySelector<HTMLButtonElement>('[data-calendar-step="next"]')!
        .click();
      return scrollY - before;
    }),
  ).toBe(0);
  await expect(card(orientation.id)).not.toHaveAttribute(
    "data-calendar-highlight",
    "",
  );
  await expect(link(distant.id)).toBeVisible();
  const start = await calendar.getAttribute("data-calendar-start");
  const version = async () => {
    const response = await page.request.get(
      `/manage/events?occurrence=${distant.id}`,
    );
    expect(response.ok()).toBe(true);
    const value = (await response.text()).match(
      new RegExp(
        `data-live-event="${distant.id}"[\\s\\S]*?name="version" value="(\\d+)"`,
      ),
    )?.[1];
    expect(value).toBeDefined();
    return Number(value);
  };
  const movedDate = addCalendarDays(today, 50);
  const moved = {
    ...distant.event,
    startsAt: vancouverInstant(`${movedDate}T20:00`),
  };
  await link(distant.id).focus();
  const updated = await page.request.post("/api/v1/events/action", {
    headers: { origin: baseURL! },
    data: {
      action: "save",
      id: distant.id,
      version: await version(),
      event: moved,
    },
  });
  expect(updated.status(), await updated.text()).toBe(200);
  await expect(
    calendar.locator(
      `[data-calendar-date="${movedDate}"] [data-calendar-event="${distant.id}"]`,
    ),
  ).toBeVisible({ timeout: 15_000 });
  await expect(link(distant.id)).toBeFocused();
  await expect(calendar).toHaveAttribute("data-calendar-start", start!);
  const cancelled = await page.request.post("/api/v1/events/action", {
    headers: { origin: baseURL! },
    data: { action: "cancel-event", id: distant.id, version: await version() },
  });
  expect(cancelled.status(), await cancelled.text()).toBe(200);
  await expect(card(distant.id)).toHaveCount(0, { timeout: 15_000 });
  await expect(link(distant.id)).toHaveCount(0);
  await expect(page).toHaveURL(
    new RegExp(
      `occurrence=${orientation.id}&type=orientation#event-${orientation.id}$`,
    ),
  );
  expect(documents).toEqual([]);
});

test("View as has a button for every seeded profile and supports keyboard switching on mobile", async ({
  page,
}) => {
  for (const width of [1280, 375, 320]) {
    await page.setViewportSize({ width, height: 812 });
    const profiles = await openLocalAccountSwitcher(page);
    await expect(profiles.getByRole("combobox")).toHaveCount(0);
    for (const key of [
      "alex",
      "casey",
      "dana",
      "jamie",
      "robin",
      "sam",
      "first-sign-in",
    ]) {
      const profile = profiles.locator(
        `[data-switch-user="local-fixture-user-${key}"]`,
      );
      await expect(profile).toBeVisible();
      await expect(profile).toBeEnabled();
      await expect(profile).toContainText(`${key}.local@example.org`);
    }
    await expect(
      profiles.getByRole("button", { name: "Visitor", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
    ).toBe(false);
    await page
      .getByRole("button", { name: "Close development controls", exact: true })
      .click();
  }
  const profiles = await openLocalAccountSwitcher(page);
  const robin = profiles.locator(
    '[data-switch-user="local-fixture-user-robin"]',
  );
  await robin.focus();
  await robin.press("Enter");
  await page
    .getByRole("button", { name: "Open navigation", exact: true })
    .click();
  await expect(
    page
      .getByRole("navigation", { name: "Mobile navigation" })
      .getByRole("link", { name: "Volunteers", exact: true }),
  ).toBeVisible();
  await expect(robin).toHaveAttribute("aria-pressed", "true");
});

test("profile buttons disable during switching and recover without changing selection on failure", async ({
  page,
}) => {
  const profiles = await openLocalAccountSwitcher(page);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  await page.route("**/api/v1/auth/dev/switch-user", async (route) => {
    await gate;
    await route.fulfill({
      status: 503,
      json: { message: "Try switching again." },
    });
  });
  const robin = profiles.locator(
    '[data-switch-user="local-fixture-user-robin"]',
  );
  const visitor = profiles.getByRole("button", {
    name: "Visitor",
    exact: true,
  });
  try {
    await robin.click();
    await expect(profiles).toHaveAttribute("aria-busy", "true");
    await expect(robin).toBeDisabled();
    await expect(visitor).toBeDisabled();
  } finally {
    release();
  }
  await expect(page.locator("[data-switch-message]")).toHaveText(
    "Try switching again.",
  );
  await expect(profiles).toHaveAttribute("aria-busy", "false");
  await expect(robin).toBeEnabled();
  await expect(visitor).toBeEnabled();
  await expect(visitor).toHaveAttribute("aria-pressed", "true");
  await expect(robin).toHaveAttribute("aria-pressed", "false");
});

test("View as lists actual D1 users and switching to Visitor ends only the current session", async ({
  page,
  request,
  baseURL,
}) => {
  const user = await createLocalAccount(request, baseURL!);
  const independent = await request.get("/api/v1/auth/get-session");
  const independentSession: { session: { id: string } } =
    await independent.json();
  await page.reload();
  const profiles = await openLocalAccountSwitcher(page);
  const profile = profiles.locator(`[data-switch-user="${user.id}"]`);
  await expect(profile).toContainText(user.email);
  await expect(page.locator("[data-account-menu]")).toHaveCount(0);
  await profile.click();
  await expect(page.locator("[data-account-menu]")).toBeVisible();
  await expect(profile).toHaveAttribute("aria-pressed", "true");
  const selected = await page.request.get("/api/v1/auth/get-session");
  const selectedSession: { user: { id: string }; session: { id: string } } =
    await selected.json();
  expect(selectedSession.user.id).toBe(user.id);
  expect(selectedSession.session.id).not.toBe(independentSession.session.id);
  await (
    await openLocalAccountSwitcher(page)
  )
    .getByRole("button", { name: "Visitor", exact: true })
    .click();
  await expect(page).toHaveURL(/\/volunteer\/?$/);
  await expect(page.locator("[data-account-menu]")).toHaveCount(0);
  expect(
    await (await page.request.get("/api/v1/auth/get-session")).json(),
  ).toBeNull();
  expect(
    (await (await request.get("/api/v1/auth/get-session")).json()).session.id,
  ).toBe(independentSession.session.id);
});

test("View as can choose a D1 account without an application without changing it", async ({
  page,
  request,
  baseURL,
}) => {
  const user = await createLocalAccount(request, baseURL!, false);
  await page.reload();
  const profiles = await openLocalAccountSwitcher(page);
  const profile = profiles.locator(`[data-switch-user="${user.id}"]`);
  await profile.click();
  await expect(page).toHaveURL(/\/apply$/);
  await expect(
    page.getByRole("heading", {
      name: "Volunteer Application",
      level: 2,
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.locator("[data-account-email]").first()).toHaveText(
    user.email,
  );
  await expect(page.getByLabel("First name")).toHaveValue("");
  await expect(profile).toHaveAttribute("aria-pressed", "true");

  await page.goto("/volunteer");
  const portal = page.locator("[data-event-browser]");
  await expect(
    page.getByRole("heading", { name: "Welcome", exact: true, level: 1 }),
  ).toBeVisible();
  await expect(
    page.getByText("Welcome to After Hours Outreach", { exact: true }),
  ).toHaveCount(0);
  await expect(portal.locator("[data-application-tracker]")).toBeVisible();
  await expect(
    portal
      .locator("[data-application-tracker]")
      .locator("xpath=preceding-sibling::*[1]"),
  ).toHaveText(
    "Thanks for your interest in volunteering. Please complete the steps below to complete your application.",
  );
  await expect(
    portal.getByRole("link", {
      name: "Complete application form",
    }),
  ).toHaveAttribute("href", "/apply");
  const discord = portal.getByRole("link", { name: "Join Discord" });
  await expect(discord).toBeVisible();
  await expect(discord).toHaveAttribute("href", social.discord);
  await expect(
    portal.locator(
      "[data-application-pending], [data-live-event], [data-event-list], [data-event-save], [data-event-notifications]",
    ),
  ).toHaveCount(0);
  const navigation = page.locator('header a[href="/volunteer"]');
  await expect(navigation).toHaveCount(2);
  await expect(navigation).toHaveText(["Volunteer", "Volunteer"]);
  await page.goto("/events?type=orientation&occurrence=example");
  await expect(page).toHaveURL(
    /\/volunteer\?type=orientation&occurrence=example$/,
  );
  await page.getByRole("link", { name: "Complete application form" }).click();
  await expect(page).toHaveURL(/\/apply$/);
});

test("account navigation and profile controls are usable on desktop and mobile", async ({
  page,
  baseURL,
}) => {
  const user = await createLocalAccount(page.request, baseURL!);
  await page.reload();
  for (const width of [1280, 375, 320]) {
    await page.setViewportSize({ width, height: 812 });
    const menu = page.locator(
      width < 1024 ? "[data-mobile-account]" : "[data-account-menu]",
    );
    if (width < 1024) {
      await page
        .getByRole("button", { name: "Open navigation", exact: true })
        .click();
      await expect(menu.locator("[data-account-menu-name]")).toHaveText(
        user.name,
      );
    } else {
      await expect(menu.locator("summary")).toHaveAccessibleName(
        `Account for ${user.name}`,
      );
      await menu.locator("summary").click();
    }
    await expect(menu).toContainText(user.email);
    await menu.getByRole("link", { name: "Account", exact: true }).click();
    await expect(page).toHaveURL(/\/volunteer\/account$/);
    await expect(
      page.getByRole("heading", { name: "Account", level: 1, exact: true }),
    ).toBeVisible();
    const form = page.locator("[data-account-profile]");
    await expect(form.locator("[data-profile-editor]")).toBeVisible();
    await expect(form.locator('[name="preferredName"]')).toBeHidden();
    await expect(
      form.locator('[data-profile-answer="preferredName"] dd'),
    ).toHaveText(sampleAnswers.preferredName);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
    ).toBe(false);
    await page.getByRole("button", { name: "Edit personal info" }).click();
    await expect(form.getByRole("heading", { level: 3 })).toHaveText([
      "Personal info",
      "Emergency contact",
      "Team interests",
      "Training and safety",
    ]);
    await expect(
      form.getByRole("group", { name: "About volunteering", exact: true }),
    ).toHaveCount(0);
    const name = page.getByLabel("Preferred name", { exact: false });
    await expect(name).toHaveValue(sampleAnswers.preferredName);
    await expect(name).toBeEditable();
    for (const heading of await form.getByRole("heading", { level: 3 }).all()) {
      await expect(heading).toHaveCSS(
        "font-size",
        width < 768 ? "18px" : "20px",
      );
      await expect(heading).toHaveCSS("font-weight", "700");
      await expect(heading.locator("..")).toHaveCSS(
        "border-bottom-width",
        "1px",
      );
    }
    await form.getByRole("button", { name: "Cancel", exact: true }).click();
    await page.getByRole("button", { name: "Edit emergency contact" }).click();
    const emergencyContact = page.getByRole("group", {
      name: "Emergency contact",
      exact: true,
    });
    await expect(emergencyContact).toBeVisible();
    await expect(emergencyContact.locator("input")).toHaveCount(3);
    for (const field of [
      "emergencyName",
      "emergencyPhone",
      "emergencyRelationship",
    ] as const)
      await expect(
        emergencyContact.locator(`input[name="${field}"]`),
      ).toHaveValue(sampleAnswers[field]);
    await expect(emergencyContact).toHaveCSS("border-top-width", "0px");
    await expect(emergencyContact).toHaveCSS("padding", "0px");
    const emergencyGrid = emergencyContact.locator(".volunteer-fields");
    await expect(emergencyGrid).toBeVisible();
    expect(
      await emergencyGrid.evaluate(
        (element) =>
          getComputedStyle(element).gridTemplateColumns.split(" ").length,
      ),
    ).toBe(1);
    await form.getByRole("button", { name: "Cancel", exact: true }).click();
    await page.getByRole("button", { name: "Edit team interests" }).click();
    const teamGrid = form.locator(".volunteer-team-options");
    await expect(teamGrid).toBeVisible();
    expect(
      await teamGrid.evaluate(
        (element) =>
          getComputedStyle(element).gridTemplateColumns.split(" ").length,
      ),
    ).toBe(1);
    const medic = form.getByLabel("Medic", { exact: true });
    await medic.check();
    const certifications = form.locator("[data-medic-certifications]");
    await expect(certifications).toBeVisible();
    expect(
      await certifications
        .locator(".volunteer-certification-options")
        .evaluate(
          (element) =>
            getComputedStyle(element).gridTemplateColumns.split(" ").length,
        ),
    ).toBe(1);
    const certificationOptions = certifications.locator(
      ".volunteer-certification-options > label",
    );
    await expect(certificationOptions).toHaveCount(6);
    for (const option of await certificationOptions.all()) {
      await expect(option).toHaveCSS("align-items", "flex-start");
      await expect(option).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
      await expect(option).toHaveCSS("padding-inline-start", "0px");
      await expect(option).toHaveCSS("padding-inline-end", "0px");
      await expect(option).toHaveCSS("border-top-width", "0px");
    }
    await certifications
      .getByText(
        "Respiratory Therapist (RT) / Nurse Practitioner (NP) / Physician",
        { exact: true },
      )
      .click();
    const practitioner = certifications.getByRole("radio", {
      name: "Respiratory Therapist (RT) / Nurse Practitioner (NP) / Physician",
      exact: true,
    });
    await expect(practitioner).toBeChecked();
    await certifications
      .getByRole("radio", { name: "Other", exact: true })
      .check();
    const otherTraining = certifications.locator(
      'label:has([value="other"]) + [data-other-training]',
    );
    await expect(otherTraining).toBeVisible();
    await expect(otherTraining.locator("label")).toHaveClass("sr-only");
    await expect(otherTraining.locator("label")).toHaveCSS(
      "position",
      "absolute",
    );
    await expect(otherTraining.locator(".volunteer-help")).toHaveCount(0);
    await expect(
      otherTraining.getByRole("textbox", {
        name: "Other training and experience",
        exact: true,
      }),
    ).toBeEditable();
    expect(
      await form.evaluate((element) => {
        const other = element
          .querySelector('[name="certifications"][value="other"]')!
          .closest("label")!;
        const details = element.querySelector("[data-other-training]")!;
        const expiry = element.querySelector("[data-certification-expiry]")!;
        return (
          details.getBoundingClientRect().top >=
            other.getBoundingClientRect().bottom &&
          expiry.getBoundingClientRect().top >=
            details.getBoundingClientRect().bottom
        );
      }),
    ).toBe(true);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
    ).toBe(false);
    await form.evaluate((element: HTMLFormElement) => element.reset());
    await form.getByRole("button", { name: "Cancel", exact: true }).click();
    await page.getByRole("button", { name: "Edit personal info" }).click();
    const save = page
      .getByRole("button", { name: "Save", exact: true })
      .first();
    await expect(save).toBeDisabled();
    await name.fill("Unsaved layout draft");
    await expect(save).toBeEnabled();
    await name.fill(sampleAnswers.preferredName);
    await expect(save).toBeDisabled();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
    ).toBe(false);
    if (width < 1024)
      await page
        .getByRole("button", { name: "Open navigation", exact: true })
        .click();
    await page
      .getByRole("navigation", {
        name: width < 1024 ? "Mobile navigation" : "Primary navigation",
      })
      .getByRole("link", { name: "Volunteer", exact: true })
      .click();
    await expect(page).toHaveURL(/\/volunteer\/?$/);
  }
  await page
    .getByRole("button", { name: "Open navigation", exact: true })
    .click();
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(page).toHaveURL(/\/volunteer\/sign-in$/);
  expect(
    await (await page.request.get("/api/v1/auth/get-session")).json(),
  ).toBeNull();
});

test("local account selection rejects cross-origin writes, unknown users and deleting manual presets", async ({
  page,
  baseURL,
}) => {
  const request = page.request;
  const user = await createLocalAccount(request, baseURL!);
  const response = await request.post("/api/v1/auth/dev/switch-user", {
    headers: { origin: "https://evil.example" },
    data: { userId: user.id },
  });
  expect(response.status()).toBe(403);
  const missingOrigin = await request.post("/api/v1/auth/dev/switch-user", {
    data: { userId: user.id },
  });
  expect(missingOrigin.status()).toBe(403);
  const crossSite = await request.get("/api/v1/auth/dev/users", {
    headers: { origin: "https://evil.example" },
  });
  expect(crossSite.status()).toBe(403);
  const unknown = await request.post("/api/v1/auth/dev/switch-user", {
    headers: { origin: baseURL! },
    data: { userId: "not-a-user" },
  });
  expect(unknown.status()).toBe(404);
  const presetIds = ["applied", "accepted", "inactive", "organizer"].map(
    (key) => `local-account-user-${key}`,
  );
  for (const userId of presetIds) {
    const deletion = await request.post("/api/v1/auth/dev/delete-user", {
      headers: { origin: baseURL! },
      data: { userId, confirm: true },
    });
    expect(deletion.status()).toBe(403);
    expect(await deletion.text()).toContain(
      "Manual preset accounts cannot be deleted.",
    );
  }
  for (const origin of ["https://evil.example", null]) {
    const deletion = await request.post("/api/v1/auth/dev/delete-user", {
      headers: origin ? { origin } : undefined,
      data: { userId: user.id, confirm: true },
    });
    expect(deletion.status()).toBe(403);
  }
  for (const userId of ["not-a-user", "new-application"]) {
    const deletion = await request.post("/api/v1/auth/dev/delete-user", {
      headers: { origin: baseURL! },
      data: { userId, confirm: true },
    });
    expect(deletion.status()).toBe(404);
  }
  const referenced = await request.post("/api/v1/auth/dev/delete-user", {
    headers: { origin: baseURL! },
    data: { userId: "local-fixture-user-robin", confirm: true },
  });
  expect(referenced.status()).toBe(409);
  expect(await referenced.text()).toContain("referenced by organizer records");
  const unconfirmed = await request.post("/api/v1/auth/dev/delete-user", {
    headers: { origin: baseURL! },
    data: { userId: user.id },
  });
  expect(unconfirmed.status()).toBe(400);
  expect(
    (await (await request.get("/api/v1/auth/get-session")).json()).user.id,
  ).toBe(user.id);
  // Manual presets are opt-in fixtures; runtime tests cover their persisted records.
  await page.route("**/api/v1/auth/dev/users", async (route) => {
    const response = await route.fetch();
    const listing = await response.json();
    await route.fulfill({
      json: {
        ...listing,
        users: [
          ...listing.users,
          ...presetIds.map((id) => ({
            id,
            name: "Renamed preset",
            email: `${id}@example.invalid`,
            role: "volunteer",
          })),
          {
            id: "local-account-user-not-applied",
            name: "Not applied",
            email: "not-applied.local@example.org",
            role: "volunteer",
          },
        ],
      },
    });
  });
  await page.reload();
  const profiles = await openLocalAccountSwitcher(page);
  for (const id of presetIds) {
    await expect(profiles.locator(`[data-switch-user="${id}"]`)).toBeEnabled();
    await expect(profiles.locator(`[data-delete-user="${id}"]`)).toHaveCount(0);
  }
  await expect(
    profiles.locator('[data-delete-user="local-account-user-not-applied"]'),
  ).toBeVisible();
  await expect(
    profiles.locator('[data-delete-user="local-fixture-user-robin"]'),
  ).toBeVisible();
  await expect(
    profiles.locator(
      '[data-delete-user="new-application"], [data-delete-user=""]',
    ),
  ).toHaveCount(0);
  const remove = profiles.locator(`[data-delete-user="${user.id}"]`);
  await expect(remove).toBeVisible();
  page.once("dialog", (dialog) => dialog.accept());
  await remove.click();
  await expect(page).toHaveURL(/\/volunteer$/);
  expect(
    await (await request.get("/api/v1/auth/get-session")).json(),
  ).toBeNull();
});

test("View as simulates a verified factor without changing the user's real role or enrollment", async ({
  page,
  request,
  baseURL,
}) => {
  const user = await createLocalAccount(request, baseURL!);
  const enabled = await request.post("/api/v1/auth/two-factor/enable", {
    headers: { origin: baseURL! },
    data: { method: "totp" },
  });
  expect(enabled.status()).toBe(200);
  const setup: { totpURI: string } = await enabled.json();
  const verified = await request.post("/api/v1/auth/two-factor/verify-totp", {
    headers: { origin: baseURL! },
    data: {
      code: totpFromSetupKey(
        new URL(setup.totpURI).searchParams.get("secret")!,
      ),
    },
  });
  expect(verified.status()).toBe(200);
  await page.reload();
  const profiles = await openLocalAccountSwitcher(page);
  const profile = profiles.locator(`[data-switch-user="${user.id}"]`);
  await profile.click();
  await expect(page.locator("[data-account-menu]")).toBeVisible();
  await expect(profile).toHaveAttribute("aria-pressed", "true");
  const current = await page.request.get("/api/v1/auth/get-session");
  const session = await current.json();
  expect(session.user.id).toBe(user.id);
  expect(session.user.role).toBe("volunteer");
  expect(session.user.twoFactorEnabled).toBe(true);
  expect(session.session.twoFactorVerified).toBe(true);
  await expect(page.locator("[data-volunteer-menu]")).toBeHidden();
});
