import { expect, test } from "@playwright/test";
import {
  approveLocalApplication,
  createLocalAccount,
  signInLocalAuthenticatorAccount,
} from "../helpers/local-account";

test("a new volunteer can register for multiple upcoming orientations without patrol approval", async ({
  page,
  browser,
  baseURL,
}) => {
  test.skip(!baseURL?.startsWith("http://localhost:"));
  const organizer = await browser.newContext({ baseURL });
  try {
    const account = await createLocalAccount(page.request, baseURL!);
    const course = await page.request.post("/api/v1/account/naloxone", {
      headers: { origin: baseURL! },
      data: { userId: account.id, completed: true },
    });
    expect(course.status(), await course.text()).toBe(200);
    await signInLocalAuthenticatorAccount(organizer.request, baseURL!);
    await approveLocalApplication(organizer.request, baseURL!, account.id);
    const events: string[] = [];
    for (let day = 1; day <= 2; day++) {
      const event = {
        includesOrientation: true,
        startsAt: new Date(Date.now() + day * 86_400_000).toISOString(),
        meetingPoint: `Multiple orientations ${crypto.randomUUID()}`,
        meetingPointUrl: "",
        spots: 8,
        open: true,
        hidden: false,
      };
      const response = await organizer.request.post("/api/v1/events/action", {
        headers: { origin: baseURL! },
        data: { action: "save", event },
      });
      expect(response.status(), await response.text()).toBe(200);
      const listing = await organizer.request.get("/api/v1/events");
      expect(listing.status(), await listing.text()).toBe(200);
      const data = (await listing.json()) as {
        events: { id: string; meetingPoint: string }[];
      };
      const created = data.events.find(
        ({ meetingPoint }) => meetingPoint === event.meetingPoint,
      );
      expect(created).toBeDefined();
      events.push(created!.id);
    }
    await page.goto("/volunteer");
    const card = (id: string) => page.locator(`[data-live-event="${id}"]`);
    await card(events[0])
      .getByRole("button", { name: "Register", exact: true })
      .click();
    await expect(
      card(events[0]).getByRole("button", { name: "Unregister", exact: true }),
    ).toBeVisible();
    await expect(
      card(events[1]).getByRole("button", { name: "Register", exact: true }),
    ).toBeEnabled();
    await card(events[1])
      .getByRole("button", { name: "Register", exact: true })
      .click();
    for (const id of events)
      await expect(
        card(id).getByRole("button", { name: "Unregister", exact: true }),
      ).toBeVisible();
    await page.reload();
    for (const id of events)
      await expect(
        card(id).getByRole("button", { name: "Unregister", exact: true }),
      ).toBeVisible();
    await expect(
      page.getByText("You can book one upcoming orientation at a time", {
        exact: false,
      }),
    ).toHaveCount(0);
  } finally {
    await organizer.close();
  }
});
