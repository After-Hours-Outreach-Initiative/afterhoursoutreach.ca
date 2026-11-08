import { expect, test } from "@playwright/test";

for (const width of [320, 375, 639, 640, 1024, 1280]) {
  test(`e-Transfer copy button is compact and full-width below the email at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/donate");

    const block = page.getByRole("region", {
      name: "e-Transfer email address",
      exact: true,
    });
    const email = block.locator("code");
    const copyButton = page.getByRole("button", {
      name: "Copy e-Transfer email address",
    });
    await expect(email).toHaveText("finance@afterhoursoutreach.ca");
    await expect(block).toHaveCSS("white-space", "pre");
    await expect(block).toHaveCSS("overflow-x", "auto");
    await expect(block).toHaveCSS("scrollbar-width", "thin");
    await expect(copyButton).toBeVisible();
    await expect(
      copyButton.locator('[data-etransfer-copy-icon="copy"]'),
    ).toBeVisible();
    await expect(
      copyButton.locator("[data-etransfer-copy-icon]:visible"),
    ).toHaveCount(1);

    const statePositions = await copyButton
      .locator("[data-etransfer-copy-state]")
      .evaluateAll((states) =>
        states.map((state) => {
          const icon = state.querySelector("svg")!.getBoundingClientRect();
          const label = state
            .querySelector("[data-etransfer-copy-label]")!
            .getBoundingClientRect();
          return {
            iconX: icon.x,
            iconY: icon.y,
            labelX: label.x,
            labelY: label.y,
          };
        }),
      );
    for (const position of statePositions) {
      expect(position).toEqual(statePositions[0]);
    }

    const blockBounds = (await block.boundingBox())!;
    const buttonBounds = (await copyButton.boundingBox())!;
    const boxBounds = (await block.locator("..").boundingBox())!;
    expect(buttonBounds.y).toBeGreaterThanOrEqual(
      blockBounds.y + blockBounds.height,
    );
    expect(buttonBounds.x).toBeCloseTo(blockBounds.x, 1);
    expect(buttonBounds.width).toBeCloseTo(blockBounds.width, 1);
    expect(buttonBounds.height).toBeLessThanOrEqual(32);
    expect(buttonBounds.y + buttonBounds.height).toBeLessThanOrEqual(
      boxBounds.y + boxBounds.height,
    );
    expect(buttonBounds.x + buttonBounds.width).toBeLessThanOrEqual(width);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(width);

    if (width < 640) {
      const donateButtonBounds = (await page
        .getByRole("link", { name: "Donate on GoFundMe" })
        .boundingBox())!;
      expect(boxBounds.width).toBeCloseTo(donateButtonBounds.width, 1);
    } else {
      const emailBounds = (await email.boundingBox())!;
      const containerBounds = (await block.locator("../..").boundingBox())!;
      expect(boxBounds.width).toBeLessThan(containerBounds.width);
      // The desktop box fits the email plus its inner and outer padding.
      expect(boxBounds.width).toBeCloseTo(emailBounds.width + 32, 1);
    }

    if (width === 320) {
      const scrollLeft = await block.evaluate((element) => {
        element.scrollLeft = element.scrollWidth;
        return element.scrollLeft;
      });
      expect(scrollLeft).toBeGreaterThan(0);
      expect(await copyButton.boundingBox()).toEqual(buttonBounds);
    }
  });
}

test("e-Transfer copy button copies the full email after scrolling", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.setViewportSize({ width: 320, height: 900 });
  await page.goto("/donate");
  await page
    .getByRole("region", { name: "e-Transfer email address", exact: true })
    .evaluate((element) => {
      element.scrollLeft = element.scrollWidth;
    });
  const copyButton = page.locator("[data-copy-etransfer-email]");
  const feedback = copyButton.locator(
    '[data-etransfer-copy-state][aria-hidden="false"]',
  );
  await copyButton.click();

  await expect(feedback).toHaveText("Copied");
  await expect(
    copyButton.locator('[data-etransfer-copy-icon="copied"]'),
  ).toBeVisible();
  await expect(
    copyButton.locator('[data-etransfer-copy-icon="copied"]'),
  ).toHaveClass(/text-green-300/);
  await expect(
    copyButton.locator("[data-etransfer-copy-icon]:visible"),
  ).toHaveCount(1);
  await expect(copyButton).toHaveAccessibleName(
    "e-Transfer email address copied",
  );
  await expect(page.locator("[data-etransfer-copy-status]")).toHaveCount(0);
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    "finance@afterhoursoutreach.ca",
  );
});

test("e-Transfer copy failures show feedback in the button and allow retrying", async ({
  page,
}) => {
  await page.addInitScript(() => {
    let attempts = 0;
    Object.defineProperty(navigator.clipboard, "writeText", {
      value: async () => {
        if (attempts++ === 0) throw new Error("Clipboard unavailable");
      },
    });
  });
  await page.goto("/donate");
  const copyButton = page.locator("[data-copy-etransfer-email]");
  const feedback = copyButton.locator(
    '[data-etransfer-copy-state][aria-hidden="false"]',
  );
  await copyButton.click();

  await expect(feedback).toHaveText("Error");
  await expect(
    copyButton.locator('[data-etransfer-copy-icon="error"]'),
  ).toBeVisible();
  await expect(
    copyButton.locator('[data-etransfer-copy-icon="error"]'),
  ).toHaveClass(/text-red-300/);
  await expect(feedback.locator("[data-etransfer-copy-label]")).toHaveClass(
    /text-red-300/,
  );
  await expect(
    copyButton.locator("[data-etransfer-copy-icon]:visible"),
  ).toHaveCount(1);
  await expect(copyButton).toHaveAccessibleName(
    "Could not copy e-Transfer email address. Try again.",
  );
  await expect(page.locator("[data-etransfer-copy-status]")).toHaveCount(0);

  await copyButton.click();
  await expect(feedback).toHaveText("Copied");
  await expect(feedback.locator("[data-etransfer-copy-label]")).not.toHaveClass(
    /text-red-300/,
  );
  await expect(
    copyButton.locator('[data-etransfer-copy-icon="copied"]'),
  ).toBeVisible();
  await expect(
    copyButton.locator("[data-etransfer-copy-icon]:visible"),
  ).toHaveCount(1);
});

test.describe("e-Transfer copy feedback timing", () => {
  test.beforeEach(async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.addInitScript(() => {
      Object.defineProperty(navigator.clipboard, "writeText", {
        configurable: true,
        value: async () => {},
      });
    });
    const time = new Date();
    await page.clock.install({ time });
    await page.clock.pauseAt(time);
    await page.goto("/donate");
  });

  test("Copied returns to Copy after three seconds and repeated clicks restart the timer", async ({
    page,
  }) => {
    const copyButton = page.locator("[data-copy-etransfer-email]");
    const feedback = copyButton.locator(
      '[data-etransfer-copy-state][aria-hidden="false"]',
    );
    const bounds = await copyButton.boundingBox();
    await copyButton.click();
    await expect(feedback).toHaveText("Copied");
    await page.clock.fastForward(2999);
    await expect(feedback).toHaveText("Copied");
    await page.clock.fastForward(1);
    await expect(feedback).toHaveText("Copy");
    await expect(copyButton).toHaveAccessibleName(
      "Copy e-Transfer email address",
    );
    await expect(
      copyButton.locator('[data-etransfer-copy-icon="copy"]'),
    ).toBeVisible();
    expect(await copyButton.boundingBox()).toEqual(bounds);

    await copyButton.click();
    await expect(feedback).toHaveText("Copied");
    await page.clock.fastForward(2000);
    await copyButton.click();
    await page.clock.fastForward(2000);
    await expect(feedback).toHaveText("Copied");
    await page.clock.fastForward(1000);
    await expect(feedback).toHaveText("Copy");
  });

  test("Error returns to Copy after three seconds without an earlier success timer clearing it", async ({
    page,
  }) => {
    const copyButton = page.locator("[data-copy-etransfer-email]");
    const feedback = copyButton.locator(
      '[data-etransfer-copy-state][aria-hidden="false"]',
    );
    await copyButton.click();
    await expect(feedback).toHaveText("Copied");
    await page.clock.fastForward(2000);
    await page.evaluate(() => {
      Object.defineProperty(navigator.clipboard, "writeText", {
        value: async () => {
          throw new Error("Clipboard unavailable");
        },
      });
    });
    await copyButton.click();
    await expect(feedback).toHaveText("Error");
    await page.clock.fastForward(1000);
    await expect(feedback).toHaveText("Error");
    await page.clock.fastForward(1999);
    await expect(feedback).toHaveText("Error");
    await page.clock.fastForward(1);
    await expect(feedback).toHaveText("Copy");
    await expect(copyButton).toHaveAccessibleName(
      "Copy e-Transfer email address",
    );
    await expect(
      copyButton.locator('[data-etransfer-copy-icon="copy"]'),
    ).toBeVisible();
  });
});

test("e-Transfer feedback fades between states and respects reduced motion", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.addInitScript(() => {
    Object.defineProperty(navigator.clipboard, "writeText", {
      value: async () => {},
    });
  });
  await page.goto("/donate");
  const copyButton = page.locator("[data-copy-etransfer-email]");
  const initial = copyButton.locator('[data-etransfer-copy-state="copy"]');
  const copied = copyButton.locator('[data-etransfer-copy-state="copied"]');
  await copyButton.scrollIntoViewIfNeeded();
  const bounds = await copyButton.boundingBox();
  const initialIcon = (await initial.locator("svg").boundingBox())!;
  const initialLabel = (await initial
    .locator("[data-etransfer-copy-label]")
    .boundingBox())!;
  await expect(copied).toHaveCSS("transition-duration", "0.16s, 0.16s");
  await expect(copied).toHaveCSS("opacity", "0");
  await copyButton.click();
  await expect(copied).toHaveCSS("opacity", "1");
  await expect(initial).toBeHidden();
  await expect(
    copyButton.locator('[data-etransfer-copy-state][aria-hidden="false"]'),
  ).toHaveCount(1);
  expect(await copyButton.boundingBox()).toEqual(bounds);
  expect(await copied.locator("svg").boundingBox()).toEqual(initialIcon);
  const copiedLabel = (await copied
    .locator("[data-etransfer-copy-label]")
    .boundingBox())!;
  expect(copiedLabel.x).toBeCloseTo(initialLabel.x, 1);
  expect(copiedLabel.y).toBeCloseTo(initialLabel.y, 1);

  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect
    .poll(() =>
      copied.evaluate((element) =>
        Number.parseFloat(getComputedStyle(element).transitionDuration),
      ),
    )
    .toBeLessThanOrEqual(0.001);
  await expect(copied).toHaveCSS("transform", "none");
});
