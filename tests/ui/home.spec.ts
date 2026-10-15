import { expect, test } from "@playwright/test";
import { contactEmail, contactPhone, social } from "../../src/data/site";

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

for (const width of [1280, 375]) {
  test(`footer replaces nonprofit information with socials at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 812 });
    await page.goto("/");
    const footer = page.getByRole("contentinfo");
    await expect(footer.getByRole("heading")).toHaveText(["Site", "Socials"]);
    await expect(footer.getByRole("table")).toHaveCount(0);
    const socials = footer.getByRole("navigation", { name: "Social media" });
    await expect(socials.getByRole("link")).toHaveText([
      "Instagram",
      "Discord",
      "LinkedIn",
      "Facebook",
    ]);
    for (const [name, href] of [
      ["Instagram", social.instagram],
      ["Discord", social.discord],
      ["LinkedIn", social.linkedin],
      ["Facebook", social.facebook],
    ]) {
      await expect(socials.getByRole("link", { name })).toHaveAttribute(
        "href",
        href,
      );
    }
    const contact = footer.getByRole("navigation", {
      name: "Contact",
      exact: true,
    });
    await expect(contact.getByRole("link")).toHaveText([
      contactEmail,
      contactPhone,
    ]);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
    ).toBe(false);
  });
}
