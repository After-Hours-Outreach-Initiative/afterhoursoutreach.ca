import { expect, test } from "@playwright/test";

for (const fallback of [false, true]) {
  test(`directory headers remain aligned through scrolling, sorting, and resizing${fallback ? " without scroll timelines" : ""}`, async ({
    page,
  }) => {
    if (fallback)
      await page.addInitScript(() => {
        CSS.supports = () => false;
      });
    await page.setViewportSize({ width: 1440, height: 800 });
    await page.goto(
      "/dev/ui/applications/preview?scenario=paginated&latency=0",
    );
    const frame = page.locator(".volunteer-table-frame");
    const head = frame.locator("thead");
    const expectPinned = async () => {
      await expect
        .poll(async () =>
          Math.abs(
            await head.evaluate(
              (element) => element.getBoundingClientRect().top,
            ),
          ),
        )
        .toBeLessThan(1);
    };
    await expect(frame).toHaveAttribute("data-table-header", "native");
    await frame.evaluate((element) =>
      window.scrollTo(0, element.getBoundingClientRect().top + scrollY + 200),
    );
    await expectPinned();

    await page.setViewportSize({ width: 375, height: 800 });
    await expect(frame).toHaveAttribute(
      "data-table-header",
      fallback ? "fallback" : "timeline",
    );
    await page.evaluate(() => window.scrollBy(0, 300));
    await expectPinned();
    await expect(head).toHaveCSS("background-color", "rgb(23, 26, 32)");
    await expect(head.locator("th").first()).toHaveCSS(
      "border-top-left-radius",
      "0px",
    );
    await frame.evaluate((element) => (element.scrollLeft = 120));
    expect(
      await head.evaluate((element) =>
        Math.abs(
          element.getBoundingClientRect().left -
            element.closest("table")!.tBodies[0].getBoundingClientRect().left,
        ),
      ),
    ).toBeLessThan(1);

    await head.locator('[data-volunteer-sort="role"]').click();
    await expect(head.locator('[aria-sort="ascending"]')).toContainText("Role");
    await expect(frame).toHaveAttribute(
      "data-table-header",
      fallback ? "fallback" : "timeline",
    );
    await expectPinned();
    await page.setViewportSize({ width: 1440, height: 800 });
    await expect(frame).toHaveAttribute("data-table-header", "native");
    await expect(head).toHaveCSS("transform", "none");
    await expectPinned();
  });
}
