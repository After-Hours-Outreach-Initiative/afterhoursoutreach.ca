import { expect, test } from "@playwright/test";
import { createLocalAccount } from "../helpers/local-account";

for (const width of [390, 1280]) {
  for (const submitted of [false, true]) {
    const path = submitted ? "/volunteer/account" : "/apply";
    const prefix = submitted ? "account-profile" : "application";
    const first = submitted
      ? "account-profile-heading"
      : "application-overview";
    const emergency = `${prefix}-emergency-contact`;
    test(`${path} uses native fragments without heading focus at ${width}px`, async ({
      page,
      baseURL,
    }) => {
      test.skip(!baseURL?.startsWith("http://localhost:"));
      await page.setViewportSize({ width, height: 900 });
      await page.emulateMedia({ reducedMotion: "reduce" });
      await createLocalAccount(page.request, baseURL!, submitted);
      await page.goto(`${path}#${first}`);

      const heading = page.locator(`#${emergency}`);
      const contents = page.locator("[data-page-contents]:visible");
      const menu = contents.locator("[data-contents-menu]");
      const expectNoHeadingFocus = async () => {
        await expect(
          page.locator("h1[tabindex], h2[tabindex], h3[tabindex]"),
        ).toHaveCount(0);
        await expect(
          page.locator(
            "h1:focus-visible, h2:focus-visible, h3:focus-visible, [data-contents-actions]:focus-visible",
          ),
        ).toHaveCount(0);
      };
      await expect(page.locator(`#${first}`)).toBeInViewport();
      await expectNoHeadingFocus();
      await page.evaluate(() => {
        document.addEventListener("click", (event) => {
          if (
            event.target instanceof Element &&
            event.target.closest('[data-page-contents] a[href^="#"]')
          )
            document.documentElement.dataset.fragmentPrevented = String(
              event.defaultPrevented,
            );
        });
      });
      if (width < 1024) await menu.locator("summary").click();
      const link = contents.getByRole("link", {
        name: "Emergency contact",
        exact: true,
      });
      await page.keyboard.press("Tab");
      await link.focus();
      await expect(link).toHaveCSS("outline-style", "solid");
      await link.press("Enter");
      await expect(page).toHaveURL(`${baseURL}${path}#${emergency}`);
      await expect(page.locator("html")).toHaveAttribute(
        "data-fragment-prevented",
        "false",
      );
      await expect(heading).toBeInViewport({ ratio: 1 });
      await expectNoHeadingFocus();
      if (width < 1024) await expect(menu).not.toHaveAttribute("open");
      await page.keyboard.press("Tab");
      await expect(
        submitted
          ? page.getByRole("button", { name: "Edit emergency contact" })
          : page.locator('[name="emergencyName"]'),
      ).toBeFocused();

      // Reloading after keyboard use must not focus the fragment heading.
      await page.reload();
      await expect(heading).toBeInViewport({ ratio: 1 });
      await expectNoHeadingFocus();
      await page.goBack();
      await expect(page).toHaveURL(`${baseURL}${path}#${first}`);
      await expect(page.locator(`#${first}`)).toBeInViewport();
      await expectNoHeadingFocus();
      await page.goForward();
      await expect(page).toHaveURL(`${baseURL}${path}#${emergency}`);
      await expect(heading).toBeInViewport({ ratio: 1 });
      await expectNoHeadingFocus();

      // Native restoration keeps a reader's position, not just the fragment top.
      await page.evaluate(() => scrollBy({ top: 150, behavior: "instant" }));
      const beforeReload = await page.evaluate(() => scrollY);
      await page.reload();
      await expect.poll(() => page.evaluate(() => scrollY)).toBe(beforeReload);
      await expectNoHeadingFocus();
    });
  }
}
