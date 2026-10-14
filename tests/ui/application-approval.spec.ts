import { expect, test } from "@playwright/test";
import {
  createLocalAccount,
  openLocalAccountSwitcher,
} from "../helpers/local-account";

test("organizer approval unlocks events in place; revocation hides them again", async ({
  page,
  browser,
  baseURL,
}) => {
  test.skip(
    !baseURL?.startsWith("http://localhost:"),
    "Local D1 development only",
  );
  const volunteerContext = await browser.newContext();
  try {
    const volunteer = await volunteerContext.newPage();
    const account = await createLocalAccount(volunteer.request, baseURL!);
    await volunteer.goto(`${baseURL}/volunteer`);
    await expect(
      volunteer.getByRole("heading", {
        name: "Application awaiting approval",
      }),
    ).toBeVisible();
    await expect(
      volunteer.locator("[data-live-event], [data-event-list]"),
    ).toHaveCount(0);
    expect(
      (await volunteer.request.get(`${baseURL}/api/v1/events`)).status(),
    ).toBe(403);
    await volunteer.goto(`${baseURL}/volunteer/account`);
    await expect(
      volunteer
        .getByRole("status")
        .filter({ hasText: "awaiting organizer approval" }),
    ).toBeVisible();
    await volunteer.goto(`${baseURL}/volunteer`);

    await page.goto("/volunteer");
    await (
      await openLocalAccountSwitcher(page)
    )
      .locator('[data-switch-user="local-fixture-user-robin"]')
      .click();
    await expect(
      page.getByRole("button", { name: "Add an event", exact: true }),
    ).toBeVisible();
    await page.goto(`/volunteer/volunteers/${account.id}`);
    await page
      .getByRole("button", { name: "Approve application", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Save without email", exact: true })
      .click();
    await expect(
      page.getByRole("button", {
        name: "Revoke application approval",
        exact: true,
      }),
    ).toBeEnabled();
    await expect(volunteer.locator("[data-event-list]")).toBeVisible({
      timeout: 15_000,
    });
    await expect(volunteer.locator("[data-application-pending]")).toHaveCount(
      0,
    );
    await volunteer
      .getByRole("button", { name: "Orientations", exact: true })
      .click();
    await expect(volunteer).toHaveURL(/\?type=orientation$/);
    const orientation = volunteer
      .locator('[data-live-event][data-event-type="orientation"]')
      .filter({ hasText: "Strathcona Community Centre" });
    await orientation
      .getByRole("button", { name: "Register", exact: true })
      .click();
    await expect(
      orientation.getByText("Registered", { exact: true }),
    ).toBeVisible();
    expect(
      (await volunteer.request.get(`${baseURL}/api/v1/events`)).status(),
    ).toBe(200);

    await page
      .getByRole("button", {
        name: "Revoke application approval",
        exact: true,
      })
      .click();
    await page
      .getByRole("button", { name: "Save without email", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Approve application", exact: true }),
    ).toBeEnabled();
    await expect(
      volunteer.getByRole("heading", {
        name: "Application awaiting approval",
      }),
    ).toBeVisible({ timeout: 15_000 });
    await expect(
      volunteer.locator("[data-live-event], [data-event-list]"),
    ).toHaveCount(0);
    expect(
      (await volunteer.request.get(`${baseURL}/api/v1/events`)).status(),
    ).toBe(403);
  } finally {
    await volunteerContext.close();
  }
});
