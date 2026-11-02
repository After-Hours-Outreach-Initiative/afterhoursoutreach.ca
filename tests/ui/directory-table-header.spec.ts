import { expect, test, type Locator } from "@playwright/test";
import sharp from "sharp";

async function expectPinned(shell: Locator) {
  await expect
    .poll(() =>
      shell.evaluate((element) => {
        const bounds = element.getBoundingClientRect();
        const header = element
          .querySelector(".volunteer-table-header")!
          .getBoundingClientRect();
        const top =
          document.querySelector(".site-header")?.getBoundingClientRect()
            .bottom ?? 0;
        const expected = Math.max(
          bounds.top,
          Math.min(top, bounds.bottom - header.height),
        );
        return Math.abs(header.top - expected);
      }),
    )
    .toBeLessThan(1);
}

async function expectColumnsAligned(shell: Locator) {
  await expect
    .poll(() =>
      shell.evaluate((element) => {
        const visual = [
          ...element.querySelectorAll(".volunteer-table-header th"),
        ];
        const semantic = [
          ...element.querySelectorAll(".volunteer-table-frame thead th"),
        ];
        return Math.max(
          ...visual.map((cell, index) => {
            const a = cell.getBoundingClientRect();
            const b = semantic[index].getBoundingClientRect();
            return Math.max(
              Math.abs(a.left - b.left),
              Math.abs(a.width - b.width),
            );
          }),
        );
      }),
    )
    .toBeLessThan(1);
}

async function expectRowsPainted(shell: Locator) {
  // Hit testing alone misses an opaque, pointer-transparent layer over rows.
  await shell.page().evaluate(() => document.fonts.ready);
  await expect
    .poll(
      async () => {
        const clip = await shell.evaluate((element) => {
          const bounds = element
            .querySelector(".volunteer-table-frame")!
            .getBoundingClientRect();
          const headBottom = element
            .querySelector(".volunteer-table-header")!
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
          await shell.page().screenshot({ clip, scale: "css" }),
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

async function expectHeaderPainted(shell: Locator) {
  // WebKit can report correct sticky geometry before its text layer is painted.
  await expect
    .poll(
      async () => {
        const clip = await shell
          .locator('[data-volunteer-sort="name"] > span')
          .evaluate((element) => {
            const bounds = element.getBoundingClientRect();
            return {
              x: Math.ceil(bounds.left),
              y: Math.ceil(bounds.top),
              width: Math.floor(bounds.width),
              height: Math.floor(bounds.height),
            };
          });
        const { data, info } = await sharp(
          await shell.page().screenshot({ clip, scale: "css" }),
        )
          .removeAlpha()
          .raw()
          .toBuffer({ resolveWithObject: true });
        let foreground = 0;
        for (let index = 0; index < data.length; index += info.channels)
          if (
            data[index] > 150 &&
            data[index + 1] > 150 &&
            data[index + 2] > 150
          )
            foreground++;
        return foreground;
      },
      { message: "The sticky header label should remain painted" },
    )
    .toBeGreaterThan(20);
}

for (const kind of ["applications", "volunteers"]) {
  for (const width of [320, 1440]) {
    test(`${kind} use native split headers through scrolling, sorting, and resizing at ${width}px`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 800 });
      await page.emulateMedia({
        colorScheme: "light",
        reducedMotion: "reduce",
      });
      await page.goto(`/dev/ui/${kind}/preview?scenario=paginated&latency=0`);
      const shell = page.locator(".volunteer-table-shell");
      const frame = shell.locator(".volunteer-table-frame");
      const header = shell.locator(".volunteer-table-header");
      await expect(shell).toHaveAttribute("data-table-header", "split");
      await expect(frame.locator("[data-volunteer-row]")).toHaveCount(50);
      await expect(header).toHaveCSS("position", "sticky");
      await expect(header).toHaveCSS("transform", "none");
      await expect(header.locator("thead")).toHaveCSS("animation-name", "none");
      await expect(header.locator("th").first()).toHaveCSS(
        "border-top-left-radius",
        "7px",
      );
      await expect(frame).toHaveCSS("color-scheme", "dark");
      await expect(frame).toHaveCSS(
        "scrollbar-color",
        "rgb(113, 113, 122) rgb(23, 26, 32)",
      );
      expect(
        await header.evaluate((element) =>
          element.closest(".table-scroll-frame"),
        ),
      ).toBeNull();
      await expectColumnsAligned(shell);
      await expectHeaderPainted(shell);
      await expectRowsPainted(shell);

      await shell.evaluate((element) =>
        scrollTo(0, element.getBoundingClientRect().top + scrollY + 200),
      );
      await expectPinned(shell);
      await expect(shell).toHaveAttribute("data-header-stuck", "true");
      await expect(header).toHaveCSS("border-top-left-radius", "0px");
      await expect(header).toHaveCSS("border-top-width", "1px");
      await expectHeaderPainted(shell);
      await expectRowsPainted(shell);
      await frame.evaluate((element) => {
        element.scrollLeft = 80;
      });
      await expectColumnsAligned(shell);
      await expectRowsPainted(shell);
      await header.evaluate((element) => {
        element.scrollLeft = element.scrollWidth;
      });
      await expectColumnsAligned(shell);
      if (width === 320)
        expect(
          await frame.evaluate((element) => element.scrollLeft),
        ).toBeGreaterThan(0);

      // Focusing an offscreen sort control must scroll both viewports together.
      await header.locator('[data-volunteer-sort="name"]').focus();
      await expectColumnsAligned(shell);
      await page.keyboard.press("Enter");
      await expect(
        header.locator('[data-volunteer-sort="name"]'),
      ).toBeFocused();
      await expect(
        frame.getByRole("columnheader", { name: "Name", exact: true }),
      ).toHaveAttribute("aria-sort", "ascending");
      await expectPinned(shell);
      await expectColumnsAligned(shell);
      await expectRowsPainted(shell);

      await page.setViewportSize({
        width: width === 320 ? 1440 : 320,
        height: 800,
      });
      await expectColumnsAligned(shell);
      await expectPinned(shell);
      await expectRowsPainted(shell);
      expect(await frame.evaluate((element) => element.scrollTop)).toBe(0);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await page.evaluate(() => scrollTo(0, 0));
      await expect(header.locator("th").first()).toHaveCSS(
        "border-top-left-radius",
        "7px",
      );
    });
  }
}

test("native split headers stay directly below the site navigation", async ({
  page,
  baseURL,
}) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  const response = await page.request.post("/api/v1/auth/dev/switch-user", {
    headers: { origin: baseURL! },
    data: { userId: "local-fixture-user-robin", returnTo: "/volunteers" },
  });
  expect(response.status(), await response.text()).toBe(200);
  await page.goto("/volunteers");
  const shell = page.locator(".volunteer-table-shell");
  await expect(shell).toHaveAttribute("data-table-header", "split");
  await shell.evaluate((element) =>
    scrollTo(0, element.getBoundingClientRect().top + scrollY + 80),
  );
  await expectPinned(shell);
  await expectRowsPainted(shell);
  await page.setViewportSize({ width: 390, height: 720 });
  await expectPinned(shell);
  await shell.locator('[data-volunteer-sort="name"]').click();
  await expect(shell.locator(".volunteer-table-frame [aria-sort]")).toHaveText(
    "Name",
  );
  await expectPinned(shell);
  await page.setViewportSize({ width: 1440, height: 800 });
  await expectPinned(shell);
  await expectColumnsAligned(shell);
});

test("split headers need no scroll timeline support and stop at the table bottom", async ({
  page,
}) => {
  await page.addInitScript(() => {
    CSS.supports = () => false;
  });
  await page.setViewportSize({ width: 375, height: 800 });
  await page.goto("/dev/ui/applications/preview?scenario=paginated&latency=0");
  const shell = page.locator(".volunteer-table-shell");
  const header = shell.locator(".volunteer-table-header");
  await expect(shell).toHaveAttribute("data-table-header", "split");
  await page.evaluate(() => {
    const footer = document.createElement("div");
    footer.style.height = "100vh";
    document.body.appendChild(footer);
  });
  await shell.evaluate((element) =>
    scrollTo(0, element.getBoundingClientRect().bottom + scrollY - 20),
  );
  await expectPinned(shell);
  await expect
    .poll(() =>
      header.evaluate((element) =>
        Math.abs(element.getBoundingClientRect().bottom - 20),
      ),
    )
    .toBeLessThan(1);
  await page.evaluate(() => scrollBy(0, 100));
  await expect
    .poll(() =>
      header.evaluate((element) => element.getBoundingClientRect().bottom),
    )
    .toBeLessThan(0);
  await expect(header).toHaveCSS("transform", "none");
});

for (const kind of ["applications", "volunteers"]) {
  test(`${kind} keep one semantic header and one set of keyboard sort controls`, async ({
    page,
  }) => {
    await page.goto(`/dev/ui/${kind}/preview?scenario=paginated&latency=0`);
    const shell = page.locator(".volunteer-table-shell");
    await expect(shell).toHaveAttribute("data-table-header", "split");
    const labels =
      kind === "applications"
        ? ["Name", "Role", "Status", "Completed"]
        : ["Name", "Role"];
    await expect(shell.getByRole("table")).toHaveCount(1);
    await expect(shell.getByRole("columnheader")).toHaveText(labels);
    await expect(shell.locator(".volunteer-table-frame thead a")).toHaveCount(
      0,
    );
    await expect(shell.locator("[data-volunteer-sort]")).toHaveCount(
      labels.length,
    );
    const sort = shell.locator('[data-volunteer-sort="name"]');
    await expect(sort).toHaveAttribute("aria-controls", `${kind}-table`);
    await sort.focus();
    await page.keyboard.press("Enter");
    await expect(sort).toBeFocused();
    await expect(
      shell.getByRole("columnheader", { name: "Name", exact: true }),
    ).toHaveAttribute("aria-sort", "ascending");
    await page.keyboard.press("Enter");
    await expect(sort).toBeFocused();
    await expect(
      shell.getByRole("columnheader", { name: "Name", exact: true }),
    ).toHaveAttribute("aria-sort", "descending");
    await page.goBack();
    await expect(
      shell.getByRole("columnheader", { name: "Name", exact: true }),
    ).toHaveAttribute("aria-sort", "ascending");
    await expect(shell.locator(".volunteer-table-header")).toHaveCount(1);
    await expect(shell.getByRole("columnheader")).toHaveText(labels);
  });
}

test("sorting and semantic headers still work without JavaScript", async ({
  browser,
  baseURL,
}) => {
  const context = await browser.newContext({
    baseURL,
    javaScriptEnabled: false,
    viewport: { width: 375, height: 800 },
  });
  try {
    const page = await context.newPage();
    await page.goto(
      "/dev/ui/applications/preview?scenario=paginated&latency=0",
    );
    await expect(page.locator(".volunteer-table-header")).toHaveCount(0);
    await expect(page.getByRole("columnheader")).toHaveCount(4);
    await page.locator('[data-volunteer-sort="name"]').click();
    await expect(page).toHaveURL(/sort=name/);
    await expect(
      page.getByRole("columnheader", { name: /Name/ }),
    ).toHaveAttribute("aria-sort", "ascending");
  } finally {
    await context.close();
  }
});

test("column widths update for long names, empty searches, and restored results", async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 800 });
  await page.goto("/dev/ui/volunteers/preview?scenario=long-names&latency=0");
  const shell = page.locator(".volunteer-table-shell");
  await expect(shell).toHaveAttribute("data-table-header", "split");
  await expectColumnsAligned(shell);
  await page
    .locator("[data-volunteer-search]")
    .fill("no-matching-fictional-volunteer");
  await expect(shell.locator("[data-volunteer-row]")).toHaveCount(0);
  await expectColumnsAligned(shell);
  await expect(shell.getByRole("columnheader")).toHaveText(["Name", "Role"]);
  await page.locator("[data-volunteer-search]").fill("");
  await expect(shell.locator("[data-volunteer-row]")).toHaveCount(8);
  await expectColumnsAligned(shell);
  await page.setViewportSize({ width: 1440, height: 800 });
  await expectColumnsAligned(shell);
});
