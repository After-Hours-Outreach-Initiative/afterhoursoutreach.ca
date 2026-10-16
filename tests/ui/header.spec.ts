import { expect, test, type Page } from "@playwright/test";
import { createLocalAccount, sampleAnswers } from "../helpers/local-account";

async function viewAs(page: Page, origin: string, organizer: boolean) {
  const response = await page.request.post("/api/v1/auth/dev/switch-user", {
    headers: { origin },
    data: {
      userId: `local-fixture-user-${organizer ? "robin" : "casey"}`,
      returnTo: "/volunteer",
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
    await expect(header.locator("[data-volunteer-menu]")).toBeHidden();
    await expect(header.locator("[data-volunteer-children]")).toBeHidden();
    if (mobile) {
      await expect(navigation).toHaveCSS("border-top-width", "0px");
      await expect(navigation).toHaveCSS("border-bottom-width", "0px");
      for (const item of await navigation
        .locator(".header-mobile-links > li")
        .all())
        await expect(item).toHaveCSS("border-bottom-width", "0px");
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
    await expect(header.locator("[data-volunteer-menu]")).toBeHidden();
    await expect(
      navigation.getByRole("link", { name: "Volunteer", exact: true }),
    ).toBeVisible();
    await expect(
      navigation.getByRole("link", { name: "Events", exact: true }),
    ).toBeHidden();

    await viewAs(page, baseURL!, true);
    await page.goto("/about");
    if (mobile) {
      await header
        .getByRole("button", { name: "Open navigation", exact: true })
        .click();
      await expect(account).toBeVisible();
      const parent = navigation.getByRole("link", {
        name: "Volunteer",
        exact: true,
      });
      const children = navigation.getByRole("list", {
        name: "Volunteer pages",
      });
      await expect(children.getByRole("link")).toHaveText([
        "Events",
        "Volunteers",
      ]);
      await expect(children).toHaveCSS("border-left-width", "0px");
      await expect(
        children.getByRole("link", { name: "Events", exact: true }),
      ).toHaveCSS("font-size", "18px");
      const parentBox = await parent.boundingBox();
      const childBox = await children
        .getByRole("link", { name: "Events", exact: true })
        .boundingBox();
      expect(childBox!.x).toBeGreaterThan(parentBox!.x);
      const lastChildBox = await children
        .getByRole("link", { name: "Volunteers", exact: true })
        .boundingBox();
      const donateBox = await navigation
        .getByRole("link", { name: "Donate", exact: true })
        .boundingBox();
      expect(donateBox!.y).toBe(lastChildBox!.y + lastChildBox!.height);
      await children
        .getByRole("link", { name: "Volunteers", exact: true })
        .click();
    } else {
      const volunteer = header.locator("[data-volunteer-menu]");
      await expect(volunteer).toBeVisible();
      const toggle = volunteer.locator("summary");
      await toggle.focus();
      await toggle.press("Enter");
      await expect(toggle).toHaveAttribute("aria-expanded", "true");
      await expect(volunteer.getByRole("link")).toHaveText([
        "Events",
        "Volunteers",
      ]);
      await volunteer
        .getByRole("link", { name: "Volunteers", exact: true })
        .click();
    }
    await expect(page).toHaveURL(/\/volunteer\/volunteers$/);
    await page.waitForLoadState("load");
    await expect(page.locator("[data-volunteer-browser]")).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Volunteers", level: 2, exact: true }),
    ).toBeVisible();
    await expect(page.locator(".volunteer-nav")).toHaveCount(0);
    const toggle = mobile
      ? header.locator(".mobile-nav > summary")
      : header.locator("[data-volunteer-menu] > summary");
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(
      navigation.getByRole("link", { name: "Volunteers", exact: true }),
    ).toHaveAttribute("aria-current", "page");

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
      await expect(account.locator(".header-account-icon")).toHaveCount(0);
      const sitePagesBox = await sitePages.boundingBox();
      const accountBox = await account.boundingBox();
      expect(accountBox!.y).toBeGreaterThanOrEqual(
        sitePagesBox!.y + sitePagesBox!.height + 16,
      );
      const nameBox = await account
        .locator("[data-account-menu-name]")
        .boundingBox();
      const emailBox = await account
        .locator("[data-account-email]")
        .boundingBox();
      expect(emailBox!.x).toBe(nameBox!.x);
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
    const accountLink = card.getByRole("link", {
      name: "Account",
      exact: true,
    });
    await expect(accountLink).toBeVisible();
    await expect(accountLink).toHaveCSS("font-size", "16px");
    await expect(
      card.getByRole("button", { name: "Sign out", exact: true }),
    ).toBeVisible();
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
  });
}

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
  await expect(signOut).toHaveCSS("min-height", "44px");
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
    data: { ...sampleAnswers, firstName: "Taylor", preferredName: "" },
  });
  expect(response.status(), await response.text()).toBe(200);
  await page.goto("/volunteer/account");
  const greeting = page.locator("[data-account-greeting]");
  const cardNames = page.locator("[data-account-menu-name]");
  await expect(greeting).toHaveText("Taylor");
  await expect(cardNames).toHaveText([
    "Taylor Test Volunteer",
    "Taylor Test Volunteer",
  ]);
  await page.getByRole("button", { name: "Edit profile" }).click();
  await page.getByRole("textbox", { name: /^Preferred name/ }).fill("Tay");
  await page.getByRole("button", { name: "Save profile", exact: true }).click();
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
  await page.goto("/volunteer");
  const events = page.getByRole("heading", {
    name: "Events",
    level: 2,
    exact: true,
  });
  const size = await events.evaluate(
    (element) => getComputedStyle(element).fontSize,
  );
  await page.goto("/volunteer/volunteers");
  const volunteers = page.getByRole("heading", {
    name: "Volunteers",
    level: 2,
    exact: true,
  });
  await expect(volunteers).toBeVisible();
  await expect(volunteers).toHaveCSS("font-size", size);
});
