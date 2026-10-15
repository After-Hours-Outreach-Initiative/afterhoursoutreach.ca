import { expect, test } from "@playwright/test";

test("home page offers volunteering without an upcoming events section", async ({
  page,
}) => {
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Upcoming events" }),
  ).toHaveCount(0);
  await expect(
    page.locator('#events, [href="#events"], [data-event-teaser]'),
  ).toHaveCount(0);
  await expect(
    page.getByRole("link", { name: "Volunteer with us", exact: true }),
  ).toHaveAttribute("href", "/volunteer");
});
