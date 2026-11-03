import { expect, test } from "@playwright/test";

for (const javaScriptEnabled of [true, false]) {
  test.describe(`horizontal filters with JavaScript ${javaScriptEnabled ? "enabled" : "disabled"}`, () => {
    test.use({ javaScriptEnabled });

    test("filters stay on one row, scroll within the page, and reveal keyboard-focused options", async ({
      page,
    }) => {
      await page.goto("/dev/ui/applications/preview?scenario=mixed&latency=0");
      const filters = page.getByRole("group", { name: "Application status" });
      const buttons = filters.getByRole("button");
      await expect(buttons).toHaveCount(5);
      await page.evaluate(() => document.fonts.ready);

      for (const width of [320, 375, 1440]) {
        await page.setViewportSize({ width, height: 800 });
        await expect(filters).toHaveCSS("flex-wrap", "nowrap");
        const bounds = await buttons.evaluateAll((buttons) =>
          buttons.map((button) => {
            const { top, height } = button.getBoundingClientRect();
            return { top, height };
          }),
        );
        const centers = bounds.map(({ top, height }) => top + height / 2);
        expect(Math.max(...centers) - Math.min(...centers)).toBeLessThan(1);
        await expect(buttons.first()).toHaveCSS("white-space", "nowrap");
        expect(
          await filters.evaluate(
            (element) => element.scrollWidth > element.clientWidth,
          ),
        ).toBe(width < 1440);
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
        ).toBe(true);

        await buttons.first().focus();
        for (let index = 1; index < 5; index++)
          await page.keyboard.press("Tab");
        await expect(buttons.last()).toBeFocused();
        await expect
          .poll(() =>
            buttons.last().evaluate((button) => {
              const pill = button.getBoundingClientRect();
              const scroller = button
                .closest(".volunteer-filters")!
                .getBoundingClientRect();
              return Math.max(
                scroller.left - pill.left,
                pill.right - scroller.right,
              );
            }),
          )
          .toBeLessThanOrEqual(1);
        if (width < 1440)
          expect(
            await filters.evaluate((element) => element.scrollLeft),
          ).toBeGreaterThan(0);
      }
      await page.keyboard.press("Enter");
      await expect(page).toHaveURL(/approval=approved/);
      await expect(
        filters.getByRole("button", { name: "Approved (0)", exact: true }),
      ).toHaveAttribute("aria-pressed", "true");
    });
  });
}
