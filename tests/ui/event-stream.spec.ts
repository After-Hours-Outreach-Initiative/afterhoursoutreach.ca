import { expect, test } from "@playwright/test";
import {
  createLocalAccount,
  openLocalAccountSwitcher,
} from "../helpers/local-account";

test("other viewers see signups and cancellations through SSE without losing filters, focus or drafts", async ({
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
  await expect(
    page.getByRole("button", { name: "Add an event", exact: true }),
  ).toBeVisible();
  const meetingPoint = `Live availability ${crypto.randomUUID()}`;
  const created = await page.request.post("/api/v1/events/action", {
    headers: { origin: baseURL! },
    data: {
      action: "save",
      event: {
        type: "orientation",
        startsAt: new Date(Date.now() + 86_400_000).toISOString(),
        meetingPoint,
        meetingPointUrl: "",
        spots: 1,
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
  const visitorContext = await browser.newContext();
  const viewerContext = await browser.newContext();
  const attendeeContext = await browser.newContext();
  try {
    const visitor = await visitorContext.newPage();
    const viewer = await viewerContext.newPage();
    const attendee = await attendeeContext.newPage();
    await createLocalAccount(viewer.request, baseURL!);
    await createLocalAccount(attendee.request, baseURL!);
    const errors: string[] = [];
    for (const current of [page, visitor, viewer, attendee])
      current.on("pageerror", (error) => errors.push(error.message));
    await Promise.all([
      visitor.goto(`${baseURL}/volunteer?type=orientation`),
      viewer.goto(`${baseURL}/volunteer?type=orientation`),
      attendee.goto(`${baseURL}/volunteer?type=orientation`),
    ]);
    const card = (current: typeof page) =>
      current.locator(`[data-live-event="${eventId}"]`);
    for (const current of [visitor, viewer, attendee])
      await expect(card(current).locator(".volunteer-spots")).toHaveText(
        "1 spots left",
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
      .getByRole("button", { name: "Sign up", exact: true })
      .focus();
    const documents: string[] = [];
    viewer.on("request", (request) => {
      if (request.resourceType() === "document") documents.push(request.url());
    });
    let failedRefreshes = 0;
    await viewer.route("**/volunteer?type=orientation", (route) => {
      if (failedRefreshes++ === 0)
        return route.fulfill({ status: 503, body: "Temporary failure" });
      return route.continue();
    });
    await card(attendee)
      .getByRole("button", { name: "Sign up", exact: true })
      .click();
    for (const current of [visitor, viewer, page])
      await expect(card(current).locator(".volunteer-spots")).toHaveText(
        "Full",
        { timeout: 15_000 },
      );
    await expect(
      card(viewer).getByRole("button", { name: "Sign up", exact: true }),
    ).toHaveCount(0);
    await expect(
      viewer.getByRole("button", { name: "Orientations", exact: true }),
    ).toBeFocused();
    expect(failedRefreshes).toBeGreaterThanOrEqual(2);
    await viewer.unroute("**/volunteer?type=orientation");
    await expect(
      editor.getByLabel("Meeting point", { exact: true }),
    ).toHaveValue("Unsaved organizer draft");
    await expect(editor).toBeVisible();
    await expect(viewer).toHaveURL(/\?type=orientation$/);
    await expect(
      viewer.locator('[data-event-type="patrol"]:visible'),
    ).toHaveCount(0);
    await editor.getByRole("button", { name: "Close", exact: true }).click();
    await expect(organizerCard.locator("summary")).toHaveText("Volunteers (1)");
    // Force a reconnect while the attendee cancels. The initial stream version
    // must catch up even though the cancellation happened while disconnected.
    await viewer.evaluate(() => {
      Object.defineProperty(document, "hidden", {
        configurable: true,
        value: true,
      });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await card(attendee)
      .getByRole("button", { name: "Cancel my spot", exact: true })
      .click();
    await expect(card(visitor).locator(".volunteer-spots")).toHaveText(
      "1 spots left",
      { timeout: 15_000 },
    );
    await viewer.evaluate(() => {
      Reflect.deleteProperty(document, "hidden");
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await expect(card(viewer).locator(".volunteer-spots")).toHaveText(
      "1 spots left",
      { timeout: 15_000 },
    );
    await expect(
      card(viewer).getByRole("button", { name: "Sign up", exact: true }),
    ).toBeEnabled();
    await expect(organizerCard.locator("summary")).toHaveText("Volunteers (0)");
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
