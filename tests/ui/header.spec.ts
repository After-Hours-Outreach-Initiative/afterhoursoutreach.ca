import { expect, test, type Page } from "@playwright/test";
import { profileWriteBody } from "../helpers/profile-write";
import { createLocalAccount, sampleAnswers } from "../helpers/local-account";

async function viewAs(page: Page, origin: string, organizer: boolean) {
  const response = await page.request.post("/api/v1/auth/dev/switch-user", {
    headers: { origin },
    data: {
      userId: `local-fixture-user-${organizer ? "robin" : "casey"}`,
      returnTo: "/events",
    },
  });
  expect(response.status(), await response.text()).toBe(200);
}

test.beforeEach(async ({ baseURL }) => {
  test.skip(
    !baseURL?.startsWith("http://localhost:"),
    "Local D1 development only",
  );
});

test.beforeAll(async ({ browser, baseURL }) => {
  if (!baseURL?.startsWith("http://localhost:")) return;
  // Resolve first-use account dependencies before testing navigation. Vite's
  // initial dependency optimization otherwise reloads pages during clicks.
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

for (const width of [1280, 375]) {
  for (const signedIn of [false, true]) {
    test(`server-rendered ${signedIn ? "signed-in" : "signed-out"} headers are correct without JavaScript at ${width}px`, async ({
      browser,
      baseURL,
    }) => {
      const context = await browser.newContext({
        baseURL,
        javaScriptEnabled: false,
        viewport: { width, height: 812 },
      });
      try {
        const page = await context.newPage();
        if (signedIn) await viewAs(page, baseURL!, false);
        const header = page.getByRole("banner");
        const account = header.locator(
          width < 1024 ? "[data-mobile-account]" : "[data-header-account]",
        );
        for (const path of ["/", "/about", "/donate", "/privacy"]) {
          for (const reload of [false, true]) {
            const response = reload
              ? await page.reload()
              : await page.goto(path);
            expect(response!.status()).toBe(200);
            expect(response!.headers()["cache-control"]).toBe("no-store");
            if (path !== "/privacy")
              expect(response!.headers()["x-robots-tag"]).toBeUndefined();
            if (width < 1024)
              await header
                .getByRole("button", { name: "Open navigation", exact: true })
                .click();
            if (signedIn) {
              await expect(account).toBeVisible();
              await expect(
                account.locator(
                  width < 1024
                    ? "[data-account-menu-name]"
                    : "[data-account-greeting]",
                ),
              ).toHaveText("Casey Lee");
              for (const discord of await header
                .locator("[data-header-discord]")
                .all())
                await expect(discord).toBeHidden();
            } else {
              await expect(account).toBeHidden();
              await expect(
                header.getByRole("link", { name: "Join Discord", exact: true }),
              ).toBeVisible();
              expect(await response!.text()).not.toContain("Casey Lee");
            }
          }
        }
      } finally {
        await context.close();
      }
    });
  }
}

test("public headers need no browser-side session lookup", async ({
  page,
  baseURL,
}) => {
  const requests: string[] = [];
  page.on("request", (request) => {
    if (
      /\/api\/v1\/(?:account\/navigation|auth\/get-session)/.test(request.url())
    )
      requests.push(request.url());
  });
  await viewAs(page, baseURL!, false);
  for (const reload of [false, true]) {
    const response = reload ? await page.reload() : await page.goto("/about");
    expect(await response!.text()).toContain(
      'aria-label="Account for Casey Lee"',
    );
    await expect(page.locator("[data-header-account]")).toBeVisible();
  }
  expect(requests).toEqual([]);
});

for (const width of [1280, 1024, 768, 375, 320]) {
  test(`header shows account and role-aware volunteer navigation at ${width}px`, async ({
    page,
    baseURL,
  }) => {
    await page.setViewportSize({ width, height: 812 });
    const header = page.getByRole("banner");
    const mobile = width < 1024;
    const navigation = header.getByRole("navigation", {
      name: mobile ? "Mobile navigation" : "Primary navigation",
      exact: true,
    });

    await page.goto("/");
    expect(
      await header.evaluate(
        (element) => getComputedStyle(element, "::after").content,
      ),
    ).toBe("none");
    const brand = header.getByRole("link", {
      name: "After Hours Outreach Initiative, home",
      exact: true,
    });
    await expect(brand.locator("svg")).toHaveCSS(
      "width",
      width < 640 ? "40px" : "48px",
    );
    await expect(brand.locator("strong")).toHaveCSS("font-size", "20px");
    await expect(brand.locator("strong + span")).toHaveCSS("font-size", "16px");
    await expect(
      header.getByRole("button", { name: "Account", exact: true }),
    ).toBeHidden();
    if (mobile)
      await header
        .getByRole("button", { name: "Open navigation", exact: true })
        .click();
    await expect(
      navigation.getByRole("link", { name: "Volunteer", exact: true }),
    ).toBeVisible();
    await expect(
      navigation.getByRole("link", { name: "Volunteer", exact: true }),
    ).toHaveCSS("font-size", mobile ? "20px" : "16px");
    await expect(
      header.getByRole("link", { name: "Join Discord", exact: true }),
    ).toBeVisible();
    await expect(
      header.getByRole("link", { name: "Join Discord", exact: true }),
    ).toHaveCSS("font-size", mobile ? "18px" : "16px");
    await expect(
      navigation.getByRole("link", { name: "Events", exact: true }),
    ).toHaveCount(0);
    await expect(
      navigation.getByRole("link", { name: "Volunteers", exact: true }),
    ).toHaveCount(0);
    await expect(
      navigation.getByRole("button", { name: "Manage", exact: true }),
    ).toHaveCount(0);
    if (mobile) {
      await expect(navigation).toHaveCSS("background-color", "rgb(0, 0, 0)");
      const gutter = width < 640 ? 16 : 24;
      await expect(navigation).toHaveCSS("padding-left", `${gutter}px`);
      await expect(navigation).toHaveCSS("padding-right", `${gutter}px`);
      await expect(navigation).toHaveCSS("padding-top", "0px");
      await expect(navigation.locator(".header-mobile-links")).toHaveCSS(
        "border-top-width",
        "0px",
      );
      await expect(navigation.locator(".header-mobile-link").first()).toHaveCSS(
        "border-top-width",
        "0px",
      );
      await expect(navigation.locator(".header-mobile-link").first()).toHaveCSS(
        "padding",
        "16px 21px",
      );
      expect(
        await header.evaluate((element) => {
          const divider = getComputedStyle(element, "::after");
          return {
            content: divider.content,
            position: divider.position,
            left: divider.left,
            bottom: divider.bottom,
            width: divider.width,
            border: divider.borderBottom,
          };
        }),
      ).toEqual({
        content: '""',
        position: "absolute",
        left: "0px",
        bottom: "0px",
        width: `${width}px`,
        border: "1px solid rgb(39, 39, 42)",
      });
      const headerBox = await header.boundingBox();
      expect(headerBox).toMatchObject({
        x: 0,
        width,
        height: width < 640 ? 76 : 88,
      });
      expect((await navigation.boundingBox())!.y).toBe(
        headerBox!.y + headerBox!.height,
      );
      for (const item of await navigation
        .locator(".header-mobile-links > li > a")
        .all())
        await expect(item).toHaveCSS("border-bottom-width", "1px");
      const discord = navigation.getByRole("link", {
        name: "Join Discord",
        exact: true,
      });
      await expect(discord).toHaveClass("btn btn-primary");
      await expect(discord).toHaveCSS("justify-content", "center");
      await expect(discord).toHaveCSS("margin-top", "32px");
      const discordBox = await discord.boundingBox();
      expect(discordBox!.x).toBe(gutter);
      expect(discordBox!.width).toBe(width - gutter * 2);
    }

    // Public pages resolve the same session as the volunteer portal.
    await viewAs(page, baseURL!, false);
    await page.goto("/about");
    const account = header.locator(
      mobile ? "[data-mobile-account]" : "[data-account-menu]",
    );
    if (mobile) {
      await expect(header.locator("[data-header-account]")).toBeHidden();
      await header
        .getByRole("button", { name: "Open navigation", exact: true })
        .click();
    }
    await expect(account).toBeVisible();
    await expect(
      account.locator(
        mobile ? "[data-account-menu-name]" : "[data-account-greeting]",
      ),
    ).toHaveText("Casey Lee");
    for (const discord of await header.locator("[data-header-discord]").all())
      await expect(discord).toBeHidden();
    await expect(
      navigation.getByRole("link", { name: "Volunteer", exact: true }),
    ).toHaveCount(0);
    await expect(
      navigation.getByRole("link", { name: "Events", exact: true }),
    ).toBeVisible();
    await expect(
      navigation.getByRole("link", { name: "Events", exact: true }),
    ).toHaveAttribute("href", "/events");
    await expect(
      navigation.getByRole("link", { name: "Volunteers", exact: true }),
    ).toHaveCount(0);
    await expect(
      navigation.getByRole("button", { name: "Manage", exact: true }),
    ).toHaveCount(0);
    await expect(
      navigation.getByRole("link", { name: "About", exact: true }),
    ).toHaveCSS("color", mobile ? "rgb(212, 212, 216)" : "rgb(255, 255, 255)");

    await viewAs(page, baseURL!, true);
    await page.goto("/about");
    if (mobile) {
      await header
        .getByRole("button", { name: "Open navigation", exact: true })
        .click();
      await expect(account).toBeVisible();
    }
    await expect(
      navigation.getByRole("link", { name: "Volunteer", exact: true }),
    ).toHaveCount(0);
    await expect(
      navigation.getByRole("link", { name: "Events", exact: true }),
    ).toBeVisible();
    const manage = navigation.getByRole("button", {
      name: "Manage",
      exact: true,
    });
    await manage.focus();
    await manage.press("Enter");
    await expect(manage).toHaveAttribute("aria-expanded", "true");
    const manageMenu = manage.locator("..");
    await expect(
      manageMenu.getByRole("link", { name: "Events", exact: true }),
    ).toHaveAttribute("href", "/manage/events");
    if (mobile) {
      await expect(header.locator(".mobile-nav")).toHaveAttribute("open", "");
      await expect(manage).toHaveCSS("border-bottom-width", "1px");
      for (const child of await manageMenu.locator("a").all()) {
        await expect(child).toHaveCSS("border-top-width", "0px");
        await expect(child).toHaveCSS("border-bottom-width", "0px");
      }
    }
    const volunteersLink = navigation.getByRole("link", {
      name: "Volunteers",
      exact: true,
    });
    await expect(volunteersLink).toHaveAttribute("href", "/manage/volunteers");
    await expect(volunteersLink).toHaveCSS(
      "font-size",
      mobile ? "18px" : "16px",
    );
    await volunteersLink.click();
    await expect(page).toHaveURL(/\/manage\/volunteers$/);
    await page.waitForLoadState("load");
    await expect(page.locator("[data-volunteer-browser]")).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Volunteers", level: 2, exact: true }),
    ).toBeVisible();
    await expect(page.locator(".volunteer-nav")).toHaveCount(0);
    const toggle = header.locator(".mobile-nav > summary");
    if (mobile) {
      await toggle.click();
      await expect(toggle).toHaveAttribute("aria-expanded", "true");
    }
    await manage.click();
    await expect(
      navigation.getByRole("link", { name: "Volunteers", exact: true }),
    ).toHaveAttribute("aria-current", "page");
    await page.mouse.move(0, 0);
    await expect(
      navigation.getByRole("link", { name: "Volunteers", exact: true }),
    ).toHaveCSS("color", mobile ? "rgb(212, 212, 216)" : "rgb(255, 255, 255)");
    await page.keyboard.press("Escape");
    await expect(manage).toBeFocused();
    await expect(manage).toHaveAttribute("aria-expanded", "false");
    if (mobile) await expect(toggle).toHaveAttribute("aria-expanded", "true");

    await expect(
      account.locator(
        mobile ? "[data-account-menu-name]" : "[data-account-greeting]",
      ),
    ).toHaveText("Robin Vance");
    await expect(account.locator("[data-account-email]")).toHaveText(
      "robin.local@example.org",
    );
    if (mobile) {
      const sitePages = navigation.getByRole("list", {
        name: "Site pages",
        exact: true,
      });
      await expect(sitePages.locator("[data-mobile-account]")).toHaveCount(0);
      const icon = account.locator(".header-account-icon");
      await expect(icon).toBeVisible();
      const sitePagesBox = await sitePages.boundingBox();
      const accountBox = await account.boundingBox();
      expect(accountBox!.y).toBe(sitePagesBox!.y + sitePagesBox!.height + 48);
      const nameBox = await account
        .locator("[data-account-menu-name]")
        .boundingBox();
      const emailBox = await account
        .locator("[data-account-email]")
        .boundingBox();
      const iconBox = await icon.boundingBox();
      expect(emailBox!.x).toBe(nameBox!.x);
      expect(iconBox!.y).toBe(nameBox!.y);
      expect(iconBox!.x + iconBox!.width).toBeLessThan(nameBox!.x);
      expect(iconBox!.x + iconBox!.width).toBeLessThan(emailBox!.x);
      expect(accountBox!.x).toBe(width < 640 ? 16 : 24);
      expect(accountBox!.width).toBe(width - accountBox!.x * 2);
    } else {
      const accountToggle = account.locator("summary");
      await accountToggle.click();
      await expect(accountToggle).toHaveAttribute("aria-expanded", "true");
      await expect(toggle).toHaveAttribute("aria-expanded", "false");
      await expect(accountToggle).toHaveAccessibleName(
        "Account for Robin Vance",
      );
      await expect(account.locator("[data-account-menu-name]")).toHaveText(
        "Robin Vance",
      );
      const dropdownBox = await account
        .locator(".header-account-dropdown")
        .boundingBox();
      expect(dropdownBox!.x).toBeGreaterThanOrEqual(0);
      expect(dropdownBox!.x + dropdownBox!.width).toBeLessThanOrEqual(width);
      await expect(account.locator(".header-account-icon")).toHaveCSS(
        "border-radius",
        "50%",
      );
      await expect(account.locator(".header-account-icon")).toHaveCSS(
        "background-color",
        "rgb(22, 33, 74)",
      );
    }
    const card = account.locator(".header-account-card");
    await expect(card).toHaveCSS("background-color", "rgb(12, 13, 16)");
    await expect(card).toHaveCSS("border-width", "1px");
    await expect(card).toHaveCSS("border-radius", "10px");
    await expect(card.locator("[data-account-menu-name]")).toHaveCSS(
      "font-size",
      "16px",
    );
    await expect(card.locator("[data-account-email]")).toHaveCSS(
      "font-size",
      "14px",
    );
    const identity = card.getByRole("link", {
      name: "Robin Vance robin.local@example.org",
      exact: true,
    });
    await expect(identity).toHaveAttribute("href", "/volunteer/account");
    await expect(identity).not.toHaveAttribute("aria-current");
    await expect(identity).toHaveCSS("border-bottom-width", "0px");
    await expect(identity).toHaveCSS("overflow-wrap", "anywhere");
    await expect(identity.locator(".header-account-details")).toHaveCSS(
      "min-width",
      "0px",
    );
    const arrow = identity.locator(".header-account-arrow");
    await expect(arrow).toBeVisible();
    await expect(arrow).toHaveAttribute("aria-hidden", "true");
    await expect(arrow).toHaveAttribute("focusable", "false");
    const identityBox = await identity.boundingBox();
    const arrowBox = await arrow.boundingBox();
    const arrowSize = mobile ? 20 : 16;
    expect(arrowBox).toMatchObject({
      x: identityBox!.x + identityBox!.width - (mobile ? 16 : 12) - arrowSize,
      y: identityBox!.y + 16,
      width: arrowSize,
      height: arrowSize,
    });
    const detailsBox = await identity
      .locator(".header-account-details")
      .boundingBox();
    expect(detailsBox!.x + detailsBox!.width).toBeLessThan(arrowBox!.x);
    const divider = card.getByRole("separator");
    await expect(divider).toBeVisible();
    await expect(divider).toHaveCSS("border-top-color", "rgb(39, 39, 42)");
    const cardBox = await card.boundingBox();
    expect(await divider.boundingBox()).toMatchObject({
      x: cardBox!.x + 1,
      width: cardBox!.width - 2,
      height: 1,
    });
    await identity.hover();
    await expect(identity).toHaveCSS("background-color", "rgb(23, 26, 32)");
    const accountLink = card.getByRole("link", {
      name: "Account",
      exact: true,
    });
    await expect(accountLink).toBeVisible();
    const signOut = card.getByRole("button", { name: "Sign out", exact: true });
    await expect(signOut).toBeVisible();
    await expect(signOut.locator("svg")).toHaveCount(0);
    await expect(accountLink.locator(".header-mobile-arrow")).toHaveCount(
      mobile ? 1 : 0,
    );
    for (const action of [accountLink, signOut]) {
      await expect(action).toHaveCSS("font-size", mobile ? "18px" : "16px");
      await expect(action).toHaveCSS("min-height", mobile ? "56px" : "44px");
    }
    if (mobile) {
      const textStarts = await navigation
        .locator(
          ".header-mobile-links > li > .header-mobile-link, .header-account-card > a:not(.header-account-identity), .header-account-card button",
        )
        .evaluateAll((elements) =>
          elements.map((element) => {
            const range = document.createRange();
            range.selectNodeContents(element.firstChild!);
            return range.getBoundingClientRect().x;
          }),
        );
      expect(new Set(textStarts).size).toBe(1);
    }
    for (const discord of await header.locator("[data-header-discord]").all())
      await expect(discord).toBeHidden();
    await page.keyboard.press("Escape");
    const focused = mobile ? toggle : account.locator("summary");
    await expect(focused).toBeFocused();
    await expect(focused).toHaveAttribute("aria-expanded", "false");
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
    ).toBe(false);
    await focused.click();
    await identity.focus();
    await page.keyboard.press("Tab");
    await expect(accountLink).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(identity).toBeFocused();
    await expect(identity).toHaveCSS("outline-style", "solid");
    await expect(identity).toHaveCSS("outline-width", "3px");
    if (mobile) await identity.locator("[data-account-email]").click();
    else await identity.press("Enter");
    await expect(page).toHaveURL(/\/volunteer\/account$/);
    await page.waitForLoadState("load");
    await expect(focused).toHaveAttribute("aria-expanded", "false");
    await focused.click();
    for (const link of [identity, accountLink]) {
      await expect(link).toHaveAttribute("aria-current", "page");
      await page.mouse.move(0, 0);
      await expect(link).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
      await link.hover();
      await expect(link).toHaveCSS("background-color", "rgb(23, 26, 32)");
      await page.mouse.move(0, 0);
      await link.focus();
      await page.keyboard.press("Tab");
      await page.keyboard.press("Shift+Tab");
      await expect(link).toBeFocused();
      await expect(link).toHaveCSS("outline-style", "solid");
      await expect(link).toHaveCSS("outline-width", "3px");
    }
    await expect(accountLink).toHaveCSS("color", "rgb(212, 212, 216)");
  });
}

test("mobile navigation dims the page only while open", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("/");
  const menu = page.locator(".mobile-nav");
  const toggle = menu.locator(":scope > summary");
  const backdrop = page.locator(".header-mobile-backdrop");
  await expect(backdrop).toBeHidden();

  await toggle.focus();
  await toggle.press("Enter");
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(backdrop).toBeVisible();
  await expect(backdrop).toHaveAttribute("aria-hidden", "true");
  await expect(backdrop).toHaveCSS("background-color", "rgba(0, 0, 0, 0.6)");
  expect(await backdrop.boundingBox()).toEqual({
    x: 0,
    y: 0,
    width: 375,
    height: 812,
  });
  expect(
    await backdrop.evaluate(
      (element) => document.elementFromPoint(180, 800) === element,
    ),
  ).toBe(true);

  // The backdrop is outside the menu, so the existing outside-click handler
  // dismisses it without activating the page beneath it.
  await page.mouse.click(180, 800);
  await expect(backdrop).toBeHidden();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(page).toHaveURL(/\/$/);

  await toggle.click();
  await expect(backdrop).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(backdrop).toBeHidden();
  await expect(toggle).toBeFocused();
  await expect(toggle).toHaveAccessibleName("Open navigation");

  await toggle.click();
  await expect(backdrop).toBeVisible();
  await toggle.click();
  await expect(backdrop).toBeHidden();

  await toggle.click();
  // Keep the current page covered until the destination finishes loading.
  await page.evaluate(() => {
    document.addEventListener(
      "click",
      () => {
        const menu = document.querySelector<HTMLDetailsElement>(".mobile-nav")!;
        sessionStorage.setItem(
          "mobile-menu-open-on-navigation",
          String(menu.open),
        );
      },
      { once: true },
    );
  });
  await menu.getByRole("link", { name: "About", exact: true }).click();
  await expect(page).toHaveURL(/\/about$/);
  expect(
    await page.evaluate(() =>
      sessionStorage.getItem("mobile-menu-open-on-navigation"),
    ),
  ).toBe("true");
  await expect(backdrop).toBeHidden();

  await page.setViewportSize({ width: 768, height: 812 });
  await toggle.click();
  await expect(backdrop).toBeVisible();
  await page.setViewportSize({ width: 1024, height: 812 });
  await expect(backdrop).toBeHidden();
  await expect(menu).not.toHaveAttribute("open");
  await expect(
    page.getByRole("navigation", { name: "Primary navigation", exact: true }),
  ).toBeVisible();
  await page.setViewportSize({ width: 375, height: 812 });
  await expect(backdrop).toBeHidden();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
});

test("mobile account controls stay reachable in a short viewport", async ({
  page,
  baseURL,
}) => {
  await page.setViewportSize({ width: 320, height: 360 });
  await viewAs(page, baseURL!, true);
  await page.goto("/about");
  const header = page.getByRole("banner");
  await header
    .getByRole("button", { name: "Open navigation", exact: true })
    .click();
  const signOut = header.locator("[data-mobile-account]").getByRole("button", {
    name: "Sign out",
    exact: true,
  });
  await signOut.scrollIntoViewIfNeeded();
  await expect(signOut).toBeInViewport();
  await expect(signOut).toHaveCSS("min-height", "56px");
  const panel = header.getByRole("navigation", {
    name: "Mobile navigation",
    exact: true,
  });
  expect(
    await panel.evaluate(
      (element) => element.scrollWidth > element.clientWidth,
    ),
  ).toBe(false);
  const bounds = await panel.boundingBox();
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(360);
});

for (const width of [1280, 375]) {
  test(`public-page account menu signs out and recovers from errors at ${width}px`, async ({
    page,
    baseURL,
  }) => {
    await page.setViewportSize({ width, height: 812 });
    await viewAs(page, baseURL!, false);
    await page.goto("/");
    const account = page.locator(
      width < 1024 ? "[data-mobile-account]" : "[data-account-menu]",
    );
    if (width < 1024)
      await page
        .getByRole("button", { name: "Open navigation", exact: true })
        .click();
    else await account.locator("summary").click();
    await page.route("**/api/v1/auth/sign-out", (route) =>
      route.fulfill({
        status: 503,
        json: { message: "Try again." },
      }),
    );
    const signOut = account.getByRole("button", {
      name: "Sign out",
      exact: true,
    });
    await signOut.click();
    await expect(account.getByRole("status")).toHaveText(
      "Could not sign out. Please try again.",
    );
    await expect(signOut).toBeEnabled();
    await page.unroute("**/api/v1/auth/sign-out");
    await signOut.click();
    await expect(page).toHaveURL(/\/volunteer\/sign-in$/);
    await expect(page.locator("[data-account-menu]")).toHaveCount(0);
    expect(
      await (await page.request.get("/api/v1/auth/get-session")).json(),
    ).toBeNull();
  });
}

test("account greeting uses the preferred name or first name and updates after saving", async ({
  page,
  baseURL,
}) => {
  await createLocalAccount(page.request, baseURL!);
  const response = await page.request.post("/api/v1/account/profile", {
    headers: { origin: baseURL! },
    data: await profileWriteBody((path) => page.request.get(path), {
      ...sampleAnswers,
      preferredName: "",
    }),
  });
  expect(response.status(), await response.text()).toBe(200);
  await page.goto("/volunteer/account");
  const greeting = page.locator("[data-account-greeting]");
  const cardNames = page.locator("[data-account-menu-name]");
  await expect(greeting).toHaveText(sampleAnswers.firstName);
  await expect(cardNames).toHaveText([
    sampleAnswers.preferredName,
    sampleAnswers.preferredName,
  ]);
  await page.getByRole("button", { name: "Edit personal info" }).click();
  await page.getByRole("textbox", { name: /^Preferred name/ }).fill("Tay");
  await page.getByRole("button", { name: "Save", exact: true }).first().click();
  await expect(greeting).toHaveText("Tay");
  await expect(cardNames).toHaveText(["Tay", "Tay"]);
  await expect(
    page.locator("[data-account-menu] > summary"),
  ).toHaveAccessibleName("Account for Tay");
  const responsePage = await page.goto("/");
  await expect(greeting).toHaveText("Tay");
  await expect(cardNames).toHaveText(["Tay", "Tay"]);
  expect(responsePage!.headers()["cache-control"]).toBe("no-store");
  expect(await responsePage!.text()).toContain('aria-label="Account for Tay"');
});

test("organizer Volunteers heading matches the Events heading", async ({
  page,
  baseURL,
}) => {
  await viewAs(page, baseURL!, true);
  await page.goto("/events");
  const events = page.getByRole("heading", {
    name: "Events",
    level: 2,
    exact: true,
  });
  const size = await events.evaluate(
    (element) => getComputedStyle(element).fontSize,
  );
  await page.goto("/manage/volunteers");
  const volunteers = page.getByRole("heading", {
    name: "Volunteers",
    level: 2,
    exact: true,
  });
  await expect(volunteers).toBeVisible();
  await expect(volunteers).toHaveCSS("font-size", size);
});
