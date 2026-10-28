import { expect, test } from "@playwright/test";
import {
  createLocalAccount,
  reviewLocalApplication,
  sampleAnswers,
} from "../helpers/local-account";

test("Code of Conduct checkbox aligns with the first text line at every font size and wrapping width", async ({
  page,
  baseURL,
}, testInfo) => {
  test.skip(
    !baseURL?.startsWith("http://localhost:"),
    "Requires local development and Chromium CDP",
  );
  const { id } = await createLocalAccount(page.request, baseURL!, false);
  // Drafts omit the two legacy free-text fields used by the profile API.
  const answers = Object.fromEntries(
    Object.entries(sampleAnswers).filter(
      ([name]) => !["heardAboutUs", "certification"].includes(name),
    ),
  );
  const saved = await page.request.put("/api/v1/account/application-draft", {
    headers: { origin: baseURL! },
    data: { userId: id, version: 1, revision: null, generation: null, answers },
  });
  expect(saved.ok(), await saved.text()).toBe(true);
  await page.goto("/apply");
  await reviewLocalApplication(page);
  const label = page.locator(".volunteer-conduct-confirmation");
  const checkbox = label.locator('input[type="checkbox"]');
  const cdp = await page.context().newCDPSession(page);
  for (const root of [16, 20, 24]) {
    await cdp.send("Page.setFontSizes", {
      fontSizes: { standard: root, fixed: root },
    });
    for (const width of [1280, 375, 320]) {
      await page.setViewportSize({ width, height: 900 });
      for (const checked of [false, true]) {
        await checkbox.setChecked(checked);
        const alignment = await label.evaluate((element) => {
          const input = element.querySelector("input")!.getBoundingClientRect();
          const text = element.querySelector("span")!;
          const bounds = text.getBoundingClientRect();
          const lineHeight = Number.parseFloat(
            getComputedStyle(text).lineHeight,
          );
          return {
            offset:
              input.top + input.height / 2 - (bounds.top + lineHeight / 2),
            lines: Math.round(bounds.height / lineHeight),
          };
        });
        expect(
          Math.abs(alignment.offset),
          `${root}px font, ${width}px viewport, checked=${checked}`,
        ).toBeLessThanOrEqual(1);
        if (width === 1280 && root === 16) expect(alignment.lines).toBe(1);
        if (width === 320) expect(alignment.lines).toBeGreaterThan(1);
      }
    }
  }
  await cdp.send("Page.setFontSizes", {
    fontSizes: { standard: 16, fixed: 16 },
  });
  await page.setViewportSize({ width: 1280, height: 900 });
  await label.screenshot({
    path: testInfo.outputPath("conduct-checkbox-alignment.png"),
  });
});
