import { expect, test } from "@playwright/test";
import {
  createLocalAccount,
  approveLocalApplication,
  openLocalAccountSwitcher,
} from "../helpers/local-account";

test("event checks run every five seconds, retry failures, and pause without overlapping requests", async ({
  page,
}) => {
  await page.clock.install();
  await page.clock.pauseAt(new Date());
  let checks = 0;
  let finishedChecks = 0;
  page.on("requestfinished", (request) => {
    if (request.url().endsWith("/api/v1/events/version")) finishedChecks++;
  });
  let version: string | null = null;
  let release!: () => void;
  const heldCheck = new Promise<void>((resolve) => (release = resolve));
  await page.route("**/api/v1/events/version", async (route) => {
    const check = ++checks;
    version ??= await page
      .locator("[data-event-browser]")
      .getAttribute("data-event-version");
    if (check === 5) await heldCheck;
    await route.fulfill(
      check === 3
        ? { status: 503, body: "Temporary failure" }
        : { json: { version } },
    );
  });
  let pageRefreshes = 0;
  page.on("request", (request) => {
    if (
      new URL(request.url()).pathname === "/volunteer" &&
      request.resourceType() !== "document"
    )
      pageRefreshes++;
  });
  try {
    await page.goto("/volunteer");
    await expect.poll(() => checks).toBe(1);
    await expect.poll(() => finishedChecks).toBe(1);
    await page.clock.runFor(4_999);
    expect(checks).toBe(1);
    await page.clock.runFor(1);
    await expect.poll(() => checks).toBe(2);
    await expect.poll(() => finishedChecks).toBe(2);
    await page.clock.runFor(5_000);
    await expect.poll(() => checks).toBe(3);
    await expect.poll(() => finishedChecks).toBe(3);
    await page.clock.runFor(5_000);
    await expect.poll(() => checks).toBe(4);
    await expect.poll(() => finishedChecks).toBe(4);
    expect(pageRefreshes).toBe(0);

    await page.clock.runFor(5_000);
    await expect.poll(() => checks).toBe(5);
    await page.clock.runFor(15_000);
    expect(checks).toBe(5);
    const completed = page.waitForEvent("requestfinished", {
      predicate: (request) => request.url().endsWith("/api/v1/events/version"),
    });
    release();
    await completed;
    await page.clock.runFor(5_000);
    await expect.poll(() => checks).toBe(6);

    await page.evaluate(() => {
      Object.defineProperty(document, "hidden", {
        configurable: true,
        value: true,
      });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await page.clock.runFor(15_000);
    expect(checks).toBe(6);
    await page.evaluate(() => {
      Reflect.deleteProperty(document, "hidden");
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await expect.poll(() => checks).toBe(7);

    await page.evaluate(() => window.dispatchEvent(new Event("pagehide")));
    await page.clock.runFor(15_000);
    expect(checks).toBe(7);
    await page.evaluate(() => {
      window.dispatchEvent(new Event("pageshow"));
      window.dispatchEvent(new Event("pageshow"));
    });
    await expect.poll(() => checks).toBe(8);
    await page.clock.runFor(5_000);
    await expect.poll(() => checks).toBe(9);
    expect(pageRefreshes).toBe(0);
  } finally {
    release();
  }
});

test("event polling pauses after five idle minutes and checks for updates on return without reloading", async ({
  page,
}) => {
  await page.clock.install();
  await page.clock.pauseAt(new Date());
  let checks = 0;
  let finishedChecks = 0;
  let version: string | null = null;
  page.on("requestfinished", (request) => {
    if (request.url().endsWith("/api/v1/events/version")) finishedChecks++;
  });
  await page.route("**/api/v1/events/version", async (route) => {
    const check = ++checks;
    version ??= await page
      .locator("[data-event-browser]")
      .getAttribute("data-event-version");
    await route.fulfill({
      json: { version: check === 5 ? "0".repeat(64) : version },
    });
  });
  await page.goto("/volunteer");
  await expect.poll(() => finishedChecks).toBe(1);
  let documents = 0;
  let pageRefreshes = 0;
  page.on("request", (request) => {
    if (request.resourceType() === "document") documents++;
    else if (new URL(request.url()).pathname === "/volunteer") pageRefreshes++;
  });

  await page.clock.fastForward(240_000);
  await expect.poll(() => finishedChecks).toBe(2);
  await page.mouse.move(20, 20);
  expect(checks).toBe(2);
  // Activity extends the deadline past the original five-minute timeout.
  await page.clock.fastForward(60_000);
  await expect.poll(() => finishedChecks).toBe(3);
  await page.clock.fastForward(239_999);
  await expect.poll(() => finishedChecks).toBe(4);
  await page.clock.runFor(1);
  await page.clock.fastForward(300_000);
  expect(checks).toBe(4);
  expect(pageRefreshes).toBe(0);

  // A changed version on return refreshes the content, not the document.
  await page.keyboard.press("Shift");
  await expect.poll(() => finishedChecks).toBe(5);
  await expect.poll(() => pageRefreshes).toBe(1);
  await page.clock.runFor(4_999);
  expect(checks).toBe(5);
  await page.clock.runFor(1);
  await expect.poll(() => finishedChecks).toBe(6);

  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", {
      configurable: true,
      value: true,
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page.clock.fastForward(300_000);
  await page.evaluate(() => {
    for (const type of [
      "pointerdown",
      "pointermove",
      "keydown",
      "input",
      "click",
      "wheel",
    ])
      document.dispatchEvent(new Event(type));
    window.dispatchEvent(new Event("focus"));
  });
  await page.clock.runFor(5_000);
  expect(checks).toBe(6);
  await page.evaluate(() => {
    Reflect.deleteProperty(document, "hidden");
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect.poll(() => finishedChecks).toBe(7);
  await page.clock.runFor(5_000);
  await expect.poll(() => finishedChecks).toBe(8);
  expect(documents).toBe(0);
  expect(pageRefreshes).toBe(1);
});

test("other viewers see signups and cancellations through polling without losing filters, focus or drafts", async ({
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
  await page.getByRole("link", { name: "Manage events", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Create", exact: true }),
  ).toBeVisible();
  const meetingPoint = `Live availability ${crypto.randomUUID()}`;
  const created = await page.request.post("/api/v1/events/action", {
    headers: { origin: baseURL! },
    data: {
      action: "save",
      event: {
        includesOrientation: true,
        startsAt: new Date(Date.now() + 86_400_000).toISOString(),
        meetingPoint,
        meetingPointUrl: "",
        spots: 4,
        open: true,
        hidden: false,
      },
    },
  });
  expect(created.status(), await created.text()).toBe(200);
  const organizerCard = page
    .locator("[data-live-event]")
    .filter({ hasText: meetingPoint });
  // Creating the event in a different request must also update this viewer.
  await expect(organizerCard).toBeVisible({ timeout: 15_000 });
  const eventId = await organizerCard.getAttribute("data-live-event");
  const reserved = await page.request.post("/api/v1/events/action", {
    headers: { origin: baseURL! },
    data: { action: "join", id: eventId },
  });
  expect(reserved.status(), await reserved.text()).toBe(200);
  const visitorContext = await browser.newContext();
  const viewerContext = await browser.newContext();
  const attendeeContext = await browser.newContext();
  try {
    const visitor = await visitorContext.newPage();
    const viewer = await viewerContext.newPage();
    const attendee = await attendeeContext.newPage();
    const viewerAccount = await createLocalAccount(viewer.request, baseURL!);
    const attendeeAccount = await createLocalAccount(
      attendee.request,
      baseURL!,
    );
    await approveLocalApplication(page.request, baseURL!, viewerAccount.id);
    await approveLocalApplication(page.request, baseURL!, attendeeAccount.id);
    const errors: string[] = [];
    for (const current of [page, visitor, viewer, attendee])
      current.on("pageerror", (error) => errors.push(error.message));
    await Promise.all([
      visitor.goto(`${baseURL}/volunteer?type=orientation`),
      viewer.goto(`${baseURL}/events?type=orientation`),
      attendee.goto(`${baseURL}/events?type=orientation`),
    ]);
    const card = (current: typeof page) =>
      current.locator(`[data-live-event="${eventId}"]`);
    await expect(
      visitor.locator("[data-live-event], [data-event-list]"),
    ).toHaveCount(0);
    for (const current of [viewer, attendee])
      await expect(card(current).locator(".volunteer-spots")).toHaveText(
        "1 spots available to you",
      );
    await organizerCard
      .getByRole("button", { name: "Edit", exact: true })
      .click();
    const editor = page.getByRole("dialog", {
      name: "Edit event",
      exact: true,
    });
    await editor
      .getByLabel("Meeting point", { exact: true })
      .fill("Unsaved organizer draft");
    await card(viewer)
      .getByRole("button", { name: "Register", exact: true })
      .focus();
    const documents: string[] = [];
    viewer.on("request", (request) => {
      if (request.resourceType() === "document") documents.push(request.url());
    });
    let failedRefreshes = 0;
    await viewer.route("**/events?type=orientation", (route) => {
      if (failedRefreshes++ === 0)
        return route.fulfill({ status: 503, body: "Temporary failure" });
      return route.continue();
    });
    await card(attendee)
      .getByRole("button", { name: "Register", exact: true })
      .click();
    await expect(
      card(attendee).getByText("Registered", { exact: true }),
    ).toBeVisible();
    await expect(
      card(attendee).getByRole("button", { name: "Unregister", exact: true }),
    ).toBeEnabled();
    for (const current of [viewer, page])
      await expect(card(current).locator(".volunteer-spots")).toHaveText(
        "No places available to you",
        { timeout: 15_000 },
      );
    await expect(
      card(viewer).getByRole("button", { name: "Register", exact: true }),
    ).toHaveCount(0);
    await expect(
      viewer.getByRole("button", { name: "Includes orientation", exact: true }),
    ).toBeFocused();
    expect(failedRefreshes).toBeGreaterThanOrEqual(2);
    await viewer.unroute("**/events?type=orientation");
    await expect(
      editor.getByLabel("Meeting point", { exact: true }),
    ).toHaveValue("Unsaved organizer draft");
    await expect(editor).toBeVisible();
    await expect(viewer).toHaveURL(/\?type=orientation$/);
    await expect(
      viewer.locator(
        '[data-live-event][data-includes-orientation="false"]:visible',
      ),
    ).toHaveCount(0);
    await editor.getByRole("button", { name: "Close", exact: true }).click();
    await expect(
      organizerCard.locator(".volunteer-roster > summary"),
    ).toHaveText("Volunteers (2)");
    // Pause polling while the attendee cancels. Becoming visible must catch up
    // even though the cancellation happened while this viewer was hidden.
    await viewer.evaluate(() => {
      Object.defineProperty(document, "hidden", {
        configurable: true,
        value: true,
      });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await card(attendee)
      .getByRole("button", { name: "Unregister", exact: true })
      .click();
    await expect(
      card(attendee).getByText("Registered", { exact: true }),
    ).toHaveCount(0);
    await expect(
      card(attendee).getByRole("button", { name: "Register", exact: true }),
    ).toBeEnabled();
    await expect(card(visitor)).toHaveCount(0);
    await viewer.evaluate(() => {
      Reflect.deleteProperty(document, "hidden");
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await expect(card(viewer).locator(".volunteer-spots")).toHaveText(
      "1 spots available to you",
      { timeout: 15_000 },
    );
    await expect(
      card(viewer).getByRole("button", { name: "Register", exact: true }),
    ).toBeEnabled();
    await expect(
      organizerCard.locator(".volunteer-roster > summary"),
    ).toHaveText("Volunteers (1)");
    expect(documents).toEqual([]);
    expect(errors).toEqual([]);
  } finally {
    await Promise.all([
      visitorContext.close(),
      viewerContext.close(),
      attendeeContext.close(),
    ]);
  }
});
