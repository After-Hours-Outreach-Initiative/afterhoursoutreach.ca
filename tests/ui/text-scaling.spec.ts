import { expect, test, type Locator, type Page } from "@playwright/test";
import { profileWriteBody } from "../helpers/profile-write";
import {
  createLocalAccount,
  openLocalAccountSwitcher,
  sampleAnswers,
} from "../helpers/local-account";

test.beforeAll(async ({ browser, baseURL }) => {
  if (!baseURL?.startsWith("http://localhost:")) return;
  // Like header.spec.ts, resolve the account page's first-use dependencies
  // before asserting navigation. Their Vite optimization reload can otherwise
  // cancel a public page's sign-in navigation while an application test starts.
  const context = await browser.newContext({ baseURL });
  try {
    const page = await context.newPage();
    await page.goto("/volunteer");
    await expect(page.locator("[data-view-as]")).toHaveAttribute(
      "aria-busy",
      "false",
    );
  } finally {
    await context.close();
  }
});

async function expectNoHorizontalOverflow(page: Page) {
  expect(
    await page.evaluate(() => ({
      document: document.documentElement.scrollWidth > innerWidth,
      // Account pages clip the body, so also check the content inside it.
      containers: [
        ...document.querySelectorAll("main, .volunteer-wrap, dialog[open]"),
      ]
        .filter((element) => element.scrollWidth > element.clientWidth + 1)
        .map((element) => element.className),
    })),
  ).toEqual({ document: false, containers: [] });
}

async function expectInsideViewport(page: Page, target: Locator) {
  await expect(target).toBeVisible();
  const bounds = (await target.boundingBox())!;
  const viewport = page.viewportSize()!;
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.y).toBeGreaterThanOrEqual(0);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(viewport.width);
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(viewport.height);
}

async function chooseSection(contents: Locator, id: string) {
  const menu = contents.locator("[data-contents-menu]");
  if (await menu.isVisible()) await menu.locator("summary").click();
  await contents.locator(`a[href="#${id}"]:visible`).click();
}

async function expectSectionAtReadingEdge(
  page: Page,
  contents: Locator,
  id: string,
  root: number,
) {
  const heading = page.locator(`#${id}`);
  await expect(heading).toBeFocused();
  await expect
    .poll(() =>
      heading.evaluate((element) =>
        Math.abs(
          element.getBoundingClientRect().top -
            Number.parseFloat(getComputedStyle(element).scrollMarginTop),
        ),
      ),
    )
    .toBeLessThanOrEqual(1);
  const flow = page.locator(
    "[data-application-flow], [data-account-contents-flow]",
  );
  const offset = await flow.evaluate((element) =>
    Number.parseFloat(
      getComputedStyle(element).getPropertyValue("--contents-scroll-offset"),
    ),
  );
  await expect(heading).toHaveCSS("scroll-margin-top", `${offset + root}px`);

  // Real scrolling must select the same section as an anchor jump. This also
  // waits beyond visit()'s immediate activation and tests the scheduled tracker.
  await heading.evaluate((element) => {
    const edge = Number.parseFloat(getComputedStyle(element).scrollMarginTop);
    scrollTo({
      top: scrollY + element.getBoundingClientRect().top - edge - 4,
      behavior: "instant",
    });
  });
  await expect(contents.locator(`a[href="#${id}"][aria-current]`)).toHaveCount(
    0,
  );
  await heading.evaluate((element) => {
    const edge = Number.parseFloat(getComputedStyle(element).scrollMarginTop);
    scrollTo({
      top: scrollY + element.getBoundingClientRect().top - edge,
      behavior: "instant",
    });
  });
  await expect(
    contents.locator(`a[href="#${id}"][aria-current="location"]`),
  ).toHaveCount(2);
  if (await contents.locator("[data-contents-menu]").isVisible())
    await expect(contents).toHaveAttribute("data-contents-stuck", "");
}

for (const root of [16, 20, 24]) {
  test.describe(`${root}px browser default font`, () => {
    test.beforeEach(async ({ page, baseURL }) => {
      test.skip(
        !baseURL?.startsWith("http://localhost:"),
        "Requires local development and Chromium CDP",
      );
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.emulateMedia({ reducedMotion: "reduce" });
      const cdp = await page.context().newCDPSession(page);
      // This changes Chromium's font preference, not an authored root style:
      // rem media queries must use it too. The page context owns the CDP session.
      await cdp.send("Page.setFontSizes", {
        fontSizes: { standard: root, fixed: root },
      });
      expect(
        await page.evaluate(() => ({
          root: getComputedStyle(document.documentElement).fontSize,
          desktop: matchMedia("(min-width: 64rem)").matches,
        })),
      ).toEqual({ root: `${root}px`, desktop: 1280 >= 64 * root });
    });

    test("public text, navigation and local email dialogs follow browser font preferences", async ({
      page,
    }) => {
      await page.goto("/about");
      await expect(page.locator("html")).toHaveCSS("font-size", `${root}px`);
      await expect(page.locator("#about p").first()).toHaveCSS(
        "font-size",
        `${(18 / 16) * root}px`,
      );
      const header = page.getByRole("banner");
      await expect(header.locator("strong").first()).toHaveCSS(
        "font-size",
        `${(20 / 16) * root}px`,
      );
      const mobile = header.locator(".mobile-nav");
      const primary = header.getByRole("navigation", {
        name: "Primary navigation",
      });
      // In particular, 1280px / 24px is compact, not a 1024px desktop layout.
      await expect(mobile).toBeVisible({ visible: 1280 < 64 * root });
      await expect(primary).toBeVisible({ visible: 1280 >= 64 * root });
      await expectNoHorizontalOverflow(page);

      await page.setViewportSize({ width: 64 * root - 1, height: 900 });
      await expect(mobile).toBeVisible();
      await mobile
        .getByRole("button", { name: "Open navigation", exact: true })
        .click();
      await expect(mobile).toHaveAttribute("open", "");
      await page.setViewportSize({ width: 64 * root, height: 900 });
      await expect(primary).toBeVisible();
      await expect(mobile).not.toHaveAttribute("open");
      // Reopening at the same breakpoint proves header.ts closed the menu,
      // rather than CSS merely concealing an incorrectly open details element.
      await page.setViewportSize({ width: 64 * root - 1, height: 900 });
      await expect(mobile).toBeVisible();
      await expect(mobile).not.toHaveAttribute("open");

      for (const width of [375, 320]) {
        await page.setViewportSize({ width, height: 812 });
        const toggle = mobile.locator(":scope > summary");
        // Body overflow clipping can conceal an off-screen menu button.
        await expectInsideViewport(page, toggle);
        await toggle.click();
        await expect(mobile).toHaveAttribute("open", "");
        await expectInsideViewport(page, toggle);
        await expectNoHorizontalOverflow(page);
        await toggle.click();
        await expect(mobile).not.toHaveAttribute("open");
      }

      await page.setViewportSize({ width: 375, height: 812 });
      const ip = crypto.getRandomValues(new Uint8Array(2));
      await page.setExtraHTTPHeaders({
        "cf-connecting-ip": `198.18.${ip[0]}.${ip[1]}`,
      });
      await page.goto("/volunteer/sign-in");
      await page
        .getByRole("textbox", { name: "Email", exact: true })
        .fill(`s-${crypto.randomUUID().slice(0, 6)}@a.test`);
      await page.getByRole("button", { name: "Continue with Email" }).click();
      await page
        .getByRole("button", { name: "Simulate successful delivery" })
        .click();
      const emailDialog = page.getByRole("dialog", {
        name: "Local sign-in email",
        exact: true,
      });
      await expect(emailDialog).toHaveClass(/\blocal-email-dialog\b/);
      await expect(emailDialog.locator(":scope > h2")).toHaveCSS(
        "font-size",
        `${(30 / 16) * root}px`,
      );
      await expect(emailDialog.locator("article > h3")).toHaveCSS(
        "font-size",
        `${(20 / 16) * root}px`,
      );
      // Assert the simulation UI, not the transactional email body's type scale.
      await expect(emailDialog).toHaveCSS("padding", `${1.25 * root}px`);
      await expect(emailDialog).toHaveCSS("border-top-width", "1px");
      await expectInsideViewport(page, emailDialog);
      await expectNoHorizontalOverflow(page);
      await emailDialog
        .getByRole("button", { name: "Close email test" })
        .click();
      await expect(emailDialog).toHaveCount(0);
    });

    test("application and account controls, dialogs and reading edges scale together", async ({
      page,
      baseURL,
    }) => {
      const account = await createLocalAccount(page.request, baseURL!, false);
      await page.goto("/apply");
      const form = page.locator("form[data-application]");
      await expect(form.locator('[name="firstName"]')).toBeEditable();
      await expect(page.locator("html")).toHaveCSS("font-size", `${root}px`);
      await expect(form.locator('label[for="profile-firstName"]')).toHaveCSS(
        "font-size",
        `${root}px`,
      );
      const input = form.locator('[name="firstName"]');
      await expect(input).toHaveCSS("font-size", `${root}px`);
      await expect(input).toHaveCSS(
        "padding",
        `${(10 / 16) * root}px ${(12 / 16) * root}px`,
      );
      await expect(input).toHaveCSS("border-top-width", "1px");
      await expect(form.locator(".volunteer-help").first()).toHaveCSS(
        "font-size",
        `${(14 / 16) * root}px`,
      );
      const checkbox = form.locator('input[type="checkbox"]').first();
      await expect(checkbox).toHaveCSS("width", `${(22 / 16) * root}px`);
      await expect(checkbox).toHaveCSS("height", `${(22 / 16) * root}px`);
      await expect(page.locator("#application-personal-info")).toHaveCSS(
        "font-size",
        `${(24 / 16) * root}px`,
      );

      const contents = page.locator("[data-application-contents]");
      await expect(contents.locator("[data-contents-menu]")).toBeVisible({
        visible: 1280 < 64 * root,
      });
      await chooseSection(contents, "application-emergency-contact");
      await expectSectionAtReadingEdge(
        page,
        contents,
        "application-emergency-contact",
        root,
      );
      await expectNoHorizontalOverflow(page);

      await openLocalAccountSwitcher(page);
      const dialog = page.getByRole("dialog", {
        name: "Local development",
        exact: true,
      });
      await expect(dialog.getByRole("heading")).toHaveCSS(
        "font-size",
        `${1.5 * root}px`,
      );
      await expect(dialog).toHaveCSS("padding", `${(28 / 16) * root}px`);
      await expect(dialog).toHaveCSS("border-top-width", "1px");
      await expect(dialog).toBeInViewport({ ratio: 1 });
      await expectNoHorizontalOverflow(page);
      await dialog
        .getByRole("button", { name: "Close development controls" })
        .click();
      await expect(dialog).not.toBeVisible();

      await page.setViewportSize({ width: 375, height: 812 });
      await chooseSection(contents, "application-team-interests");
      await expectSectionAtReadingEdge(
        page,
        contents,
        "application-team-interests",
        root,
      );
      await expectNoHorizontalOverflow(page);

      // A short compact screen exercises the bottom/top gap constraints in
      // actionsReadingEdge, not only the unchanged 75%-of-viewport branch.
      await page.setViewportSize({ width: 375, height: 250 });
      await chooseSection(contents, "application-review-and-discard");
      const actions = page.locator("#application-review-and-discard");
      await expect(actions).toBeFocused();
      await expect
        .poll(() =>
          actions.evaluate((element, gap) => {
            const bounds = element.getBoundingClientRect();
            const flow = element.closest("[data-application-flow]")!;
            const offset = Number.parseFloat(
              getComputedStyle(flow).getPropertyValue(
                "--contents-scroll-offset",
              ),
            );
            const edge = Math.max(
              offset + gap + bounds.height / 2,
              Math.min(
                innerHeight * 0.75,
                innerHeight - gap - bounds.height / 2,
              ),
            );
            return Math.abs(bounds.top + bounds.height / 2 - edge);
          }, root),
        )
        .toBeLessThanOrEqual(1);
      await expect(
        contents.locator(
          'a[href="#application-review-and-discard"][aria-current="location"]',
        ),
      ).toHaveCount(2);

      // Use the existing profile fixture to reach the real account editor,
      // without submitting a second full application through the browser.
      const submitted = await page.request.post("/api/v1/account/profile", {
        headers: { origin: baseURL! },
        data: await profileWriteBody((path) => page.request.get(path), {
          ...sampleAnswers,
          codeOfConductAccepted: true,
        }),
      });
      expect(submitted.status(), await submitted.text()).toBe(200);
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.goto("/volunteer/account");
      const accountContents = page.getByRole("navigation", {
        name: "On this page",
      });
      await chooseSection(accountContents, "account-profile-emergency-contact");
      await expectSectionAtReadingEdge(
        page,
        accountContents,
        "account-profile-emergency-contact",
        root,
      );
      await page
        .getByRole("button", { name: "Change email address", exact: true })
        .click();
      await expect(page.locator('label[for="new-email"]')).toHaveCSS(
        "font-size",
        `${root}px`,
      );
      await expect(page.locator("#new-email")).toHaveCSS(
        "font-size",
        `${root}px`,
      );
      await expect(page.locator("#new-email")).toHaveValue("");
      await expect(
        page.locator("[data-email-settings] [data-account-email]"),
      ).toHaveText(account.email);
      await page.setViewportSize({ width: 375, height: 812 });
      await expectNoHorizontalOverflow(page);
    });

    if (root === 24) {
      test("event cards and expanded rosters fit a 375px viewport", async ({
        page,
      }) => {
        await page.goto("/volunteer");
        await (
          await openLocalAccountSwitcher(page)
        )
          .locator('[data-switch-user="local-fixture-user-robin"]')
          .click();
        const card = page.locator(
          '[data-live-event="local-fixture-event-orientation"]',
        );
        await expect(card).toBeVisible();
        await page.setViewportSize({ width: 375, height: 812 });
        const roster = card.locator(".volunteer-roster");
        await roster.locator("summary").click();
        await expect(roster).toHaveAttribute("open", "");
        await expect(roster.locator(":scope > ul > li").first()).toBeVisible();
        expect(
          await card.evaluate((element) => {
            const bounds = element.getBoundingClientRect();
            return {
              overflow: element.scrollWidth > element.clientWidth + 1,
              outside: [
                ...element.querySelectorAll(
                  ".volunteer-event-top > div, .volunteer-roster > ul > li, .volunteer-roster > ul > li > div, .volunteer-roster > ul > li > button",
                ),
              ]
                .filter((child) => {
                  const rect = child.getBoundingClientRect();
                  return (
                    rect.left < bounds.left - 1 || rect.right > bounds.right + 1
                  );
                })
                .map((child) => child.className || child.tagName),
            };
          }),
        ).toEqual({ overflow: false, outside: [] });
        await expectNoHorizontalOverflow(page);
      });
    }
  });
}
