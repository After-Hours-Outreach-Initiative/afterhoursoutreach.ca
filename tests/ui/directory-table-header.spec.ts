import { expect, test, type Locator } from "@playwright/test";
import sharp from "sharp";

async function expectRowsPainted(frame: Locator) {
  // DOM visibility and hit testing both pass when a pointer-transparent header
  // layer paints over the rows. Check actual pixels without font-specific images.
  await frame.page().evaluate(() => document.fonts.ready);
  await expect
    .poll(
      async () => {
        const clip = await frame.evaluate((element) => {
          const bounds = element.getBoundingClientRect();
          const headBottom = element
            .querySelector("thead")!
            .getBoundingClientRect().bottom;
          const row = [...element.querySelectorAll("[data-volunteer-row]")]
            .map((row) => row.getBoundingClientRect())
            .find(
              (row) =>
                row.top >= Math.max(0, headBottom) && row.bottom < innerHeight,
            );
          if (!row) return null;
          const x = Math.ceil(Math.max(0, bounds.left) + 1);
          const y = Math.ceil(row.top + 1);
          return {
            x,
            y,
            width: Math.floor(Math.min(innerWidth, bounds.right) - 1) - x,
            height: Math.floor(row.bottom - 1) - y,
          };
        });
        if (!clip) return 0;
        const { data, info } = await sharp(
          await frame.page().screenshot({ clip, scale: "css" }),
        )
          .removeAlpha()
          .raw()
          .toBuffer({ resolveWithObject: true });
        let foreground = 0;
        for (let index = 0; index < data.length; index += info.channels)
          if (
            data[index] > 100 &&
            data[index + 1] > 100 &&
            data[index + 2] > 100
          )
            foreground++;
        return foreground;
      },
      {
        message:
          "Directory row text should be painted, not covered by the header",
      },
    )
    .toBeGreaterThan(20);
}

for (const kind of ["applications", "volunteers"]) {
  for (const fallback of [false, true]) {
    test(`${kind} rows stay painted below sticky headers${fallback ? " without scroll timelines" : ""}`, async ({
      page,
    }) => {
      if (fallback)
        await page.addInitScript(() => {
          CSS.supports = () => false;
        });
      await page.setViewportSize({ width: 390, height: 800 });
      await page.goto(`/dev/ui/${kind}/preview?scenario=paginated&latency=0`);
      const frame = page.locator(".volunteer-table-frame");
      await expect(frame.locator("[data-volunteer-row]")).toHaveCount(50);
      await expectRowsPainted(frame);
      await frame.evaluate((element) =>
        window.scrollTo(0, element.getBoundingClientRect().top + scrollY + 200),
      );
      await expectRowsPainted(frame);
      await frame.evaluate((element) => (element.scrollLeft = 80));
      await expectRowsPainted(frame);
      await frame.locator('[data-volunteer-sort="name"]').click();
      await expect(frame.locator("[aria-sort]")).toContainText("Name");
      await frame.evaluate((element) => (element.scrollLeft = 0));
      await expectRowsPainted(frame);
      await page.setViewportSize({ width: 1440, height: 800 });
      await expect(frame).toHaveAttribute("data-table-header", "native");
      await expectRowsPainted(frame);
    });
  }
}

for (const fallback of [false, true]) {
  test(`directory headers remain aligned through scrolling, sorting, and resizing${fallback ? " without scroll timelines" : ""}`, async ({
    page,
  }) => {
    if (fallback)
      await page.addInitScript(() => {
        CSS.supports = () => false;
      });
    await page.emulateMedia({ colorScheme: "light" });
    await page.setViewportSize({ width: 1440, height: 800 });
    await page.goto(
      "/dev/ui/applications/preview?scenario=paginated&latency=0",
    );
    const frame = page.locator(".volunteer-table-frame");
    const head = frame.locator("thead");
    await expect(frame).toHaveCSS("color-scheme", "dark");
    await expect(frame).toHaveCSS(
      "scrollbar-color",
      "rgb(113, 113, 122) rgb(23, 26, 32)",
    );
    const expectCorners = async (radius: string) => {
      await expect(head.locator("th").first()).toHaveCSS(
        "border-top-left-radius",
        radius,
      );
      await expect(head.locator("th").last()).toHaveCSS(
        "border-top-right-radius",
        radius,
      );
    };
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
      await expectCorners("0px");
      await expect(head.locator("th").first()).toHaveCSS(
        "box-shadow",
        "rgb(63, 63, 70) 0px 1px 0px 0px inset",
      );
    };
    await expect(frame).toHaveAttribute("data-table-header", "native");
    await expectCorners("7px");
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
    await expect(head).toHaveCSS("background-color", "rgb(0, 0, 0)");
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
    await page.evaluate(() => window.scrollTo(0, 0));
    await expectCorners("7px");
  });
}
