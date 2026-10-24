import { expect, test, type Locator } from "@playwright/test";
import { inPlaceAction } from "../helpers/in-place-action";
import {
  approveLocalApplication,
  createLocalAccount,
  openLocalAccountSwitcher,
} from "../helpers/local-account";

test("empty volunteer rosters stay accessible and collapse avatar space through first/last signup updates", async ({
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
  await page.getByRole("link", { name: "Manage events", exact: true }).click();
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
    await approveLocalApplication(page.request, baseURL!, account.id);
    await viewer.goto("/events");
    const cards = [page, viewer].map((current) =>
      current.locator(`[data-live-event="${id}"]`),
    );
    const roster = (card: Locator) =>
      card.locator(".volunteer-roster, .public-event-roster");
    const geometry = (card: Locator) =>
      card.evaluate((element) => {
        const bounds = (selector: string) =>
          element.querySelector(selector)!.getBoundingClientRect();
        const top = element.getBoundingClientRect().top;
        return {
          height: element.getBoundingClientRect().height,
          rowHeight:
            element.querySelector(".event-avatar-row")?.getBoundingClientRect()
              .height ?? 0,
          actionTop: bounds(".volunteer-actions").top - top,
          summaryTop: bounds("details > summary").top - top,
        };
      });
    const initial = [];
    for (const card of cards) {
      await expect(card.locator(".event-row-label")).toHaveCount(0);
      await expect(
        card.locator(".event-avatar-row .attendee-avatar"),
      ).toHaveCount(0);
      await expect(card.locator(".event-attendance")).toHaveCount(0);
      await expect(roster(card).locator("summary")).toHaveText(
        "Volunteers (0)",
      );
      const before = await geometry(card);
      expect(before.rowHeight).toBe(0);
      initial.push(before);
      const summary = roster(card).locator("summary");
      await summary.focus();
      await summary.press("Enter");
      await expect(
        roster(card).getByText("No volunteers registered yet."),
      ).toBeVisible();
      await expect(roster(card).locator("ul")).toBeHidden();
      await summary.press("Space");
      await expect(roster(card)).not.toHaveAttribute("open");
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
      await expect(roster(card).locator("summary")).toHaveText(
        "Volunteers (1)",
        {
          timeout: 15_000,
        },
      );
      await expect(
        card.locator(".event-avatar-row .attendee-avatar"),
      ).toHaveCount(1);
      await expect(roster(card)).not.toHaveAttribute("open");
      const registered = await geometry(card);
      expect(registered.rowHeight).toBeGreaterThanOrEqual(32);
      expect(registered.height).toBeGreaterThan(initial[index].height);
      expect(registered.summaryTop).toBeGreaterThan(initial[index].summaryTop);
      await roster(card).locator("summary").focus();
      await roster(card).locator("summary").press("Enter");
      await expect(roster(card).locator("li")).toHaveCount(1);
      await expect(
        roster(card).getByText("No volunteers registered yet."),
      ).toHaveCount(0);
    }
    await setRegistration("cancel");
    for (const [index, card] of cards.entries()) {
      await expect(roster(card).locator("summary")).toHaveText(
        "Volunteers (0)",
        {
          timeout: 15_000,
        },
      );
      await expect(roster(card)).toHaveAttribute("open", "");
      await expect(roster(card).locator("summary")).toBeFocused();
      await expect(
        roster(card).getByText("No volunteers registered yet."),
      ).toBeVisible();
      await expect(
        card.locator(".event-avatar-row .attendee-avatar"),
      ).toHaveCount(0);
      await roster(card).locator("summary").press("Space");
      expect(await geometry(card)).toEqual(initial[index]);
    }
    // Form submissions use the same server-rendered empty state as live polling.
    const publicCard = cards[1];
    for (const joining of [true, false]) {
      const button = publicCard.locator("[data-live-signup] button");
      await inPlaceAction(viewer, {
        endpoint: "/api/v1/events/action",
        form: publicCard.locator("[data-live-signup]"),
        trigger: () => button.click(),
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
        updated: () =>
          expect(roster(publicCard).locator("summary")).toHaveText(
            `Volunteers (${joining ? 1 : 0})`,
          ),
      });
    }
    await expect(
      publicCard.locator(".event-avatar-row .attendee-avatar"),
    ).toHaveCount(0);
  } finally {
    await viewerContext.close();
  }
});
