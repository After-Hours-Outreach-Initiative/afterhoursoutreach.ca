import { expect, test } from "@playwright/test";
import { social } from "../../src/data/site";
import {
  createLocalAccount,
  openLocalAccountSwitcher,
} from "../helpers/local-account";

test("pending applications poll every minute, then approval restores five-second event checks", async ({
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
        name: "Application Submitted",
      }),
    ).toBeVisible();
    await expect(
      volunteer.locator(
        "[data-live-event], [data-event-list], [data-event-save], [data-event-notifications]",
      ),
    ).toHaveCount(0);
    const portal = volunteer.locator("[data-event-browser]");
    const pending = portal.locator("[data-application-pending]");
    await expect(pending.locator("p").first()).toHaveText(
      `We'll review your application and email you at ${account.email} to let you know whether it's approved and what to do next.`,
    );
    await expect(pending.locator("strong")).toHaveText(account.email);
    await expect(pending.locator("h2 svg")).toHaveAttribute(
      "aria-hidden",
      "true",
    );
    await expect(
      portal.getByText(
        "You can see your submitted application on the account page.",
      ),
    ).toBeVisible();
    await expect(
      portal.getByRole("link", { name: "View Account", exact: true }),
    ).toHaveAttribute("href", "/volunteer/account");
    await expect(
      portal.getByText(
        "Join our Discord for more information and to become more involved.",
      ),
    ).toBeVisible();
    const discord = portal.getByRole("link", { name: "Join Discord" });
    await expect(discord).toBeVisible();
    await expect(discord).toHaveAttribute("href", social.discord);
    expect(
      (await volunteer.request.get(`${baseURL}/api/v1/events`)).status(),
    ).toBe(403);
    await volunteer.goto(`${baseURL}/volunteer/account`);
    await expect(
      volunteer
        .getByRole("status")
        .filter({ hasText: "awaiting organizer approval" }),
    ).toHaveCount(0);
    await volunteer.clock.install();
    await volunteer.clock.pauseAt(new Date());
    let checks = 0;
    volunteer.on("requestfinished", (request) => {
      if (request.url().endsWith("/api/v1/events/version")) checks++;
    });
    await volunteer.goto(`${baseURL}/volunteer`);
    await expect.poll(() => checks).toBe(1);

    await page.goto("/volunteer");
    await (
      await openLocalAccountSwitcher(page)
    )
      .locator('[data-switch-user="local-fixture-user-robin"]')
      .click();
    await expect(
      page.getByRole("button", { name: "Create event", exact: true }),
    ).toBeVisible();
    await page.goto(`/volunteers/${account.id}`);
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
    await volunteer.clock.runFor(59_999);
    expect(checks).toBe(1);
    await expect(pending).toBeVisible();
    await volunteer.clock.runFor(1);
    await expect.poll(() => checks).toBe(2);
    await expect(volunteer.locator("[data-event-list]")).toBeVisible({
      timeout: 15_000,
    });
    await expect(volunteer.locator("[data-application-pending]")).toHaveCount(
      0,
    );
    await expect(discord).toHaveCount(0);
    await volunteer.clock.runFor(4_999);
    expect(checks).toBe(2);
    await volunteer.clock.runFor(1);
    await expect.poll(() => checks).toBe(3);
    await volunteer
      .getByRole("button", { name: "Includes orientation", exact: true })
      .click();
    await expect(volunteer).toHaveURL(/\?type=orientation$/);
    const orientation = volunteer
      .locator('[data-live-event][data-includes-orientation="true"]')
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
    await volunteer.clock.runFor(5_000);
    await expect(
      volunteer.getByRole("heading", {
        name: "Application Submitted",
      }),
    ).toBeVisible({ timeout: 15_000 });
    await expect(
      volunteer.locator("[data-live-event], [data-event-list]"),
    ).toHaveCount(0);
    await expect(discord).toBeVisible();
    const revokedChecks = checks;
    await volunteer.clock.runFor(59_999);
    expect(checks).toBe(revokedChecks);
    await volunteer.clock.runFor(1);
    await expect.poll(() => checks).toBe(revokedChecks + 1);
    expect(
      (await volunteer.request.get(`${baseURL}/api/v1/events`)).status(),
    ).toBe(403);
  } finally {
    await volunteerContext.close();
  }
});
