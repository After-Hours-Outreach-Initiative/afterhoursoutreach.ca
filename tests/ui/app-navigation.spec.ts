import { expect, test } from "@playwright/test";
import {
  signInLocalAuthenticatorAccount,
  openLocalAccountSwitcher,
} from "../helpers/local-account";

test.use({ viewport: { width: 390, height: 844 } });

// Its searches expect only the seeded people, so it needs fresh data.
test("dock switches reuse the document, initialize revisited screens, and retain the dev panel @serial", async ({
  page,
  baseURL,
}) => {
  await signInLocalAuthenticatorAccount(page.request, baseURL!);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/events");
  await expect(page.locator("[data-event-browser]")).toBeVisible();
  await page.evaluate(() =>
    Reflect.set(window, "navigationSentinel", "same-document"),
  );
  const dock = page.getByRole("navigation", { name: "Quick navigation" });
  for (const label of [
    "Applications",
    "Volunteers",
    "Account",
    "Events",
    "Account",
    "Volunteers",
  ]) {
    await dock.getByRole("link", { name: new RegExp(label) }).click();
    await expect(
      dock.getByRole("link", { name: new RegExp(label) }),
    ).toHaveAttribute("aria-current", "page");
    await expect
      .poll(() =>
        page.evaluate(() => Reflect.get(window, "navigationSentinel")),
      )
      .toBe("same-document");
    if (label === "Applications" || label === "Volunteers") {
      const search = page.locator("[data-volunteer-search]");
      await search.fill("no person matches this test");
      await expect(page.locator("[data-volunteer-empty]")).toBeVisible();
      await search.fill("");
    }
    if (label === "Account") {
      const edit = page.locator("[data-profile-edit]").first();
      await edit.click();
      await expect(
        page.locator("[data-profile-fields]:visible").first(),
      ).toBeVisible();
      await page.locator("[data-profile-cancel]:visible").first().click();
    }
  }
  // Waiting-change banners keep their styles after every swap.
  expect(
    await page.evaluate(() =>
      [...document.styleSheets].some((sheet) =>
        [...sheet.cssRules].some(
          (rule) =>
            rule instanceof CSSStyleRule &&
            rule.selectorText === ".pending-inline",
        ),
      ),
    ),
  ).toBe(true);
  // The backdrop that dims the page, and the room under it, persist with them.
  await expect(page.locator(".pending-backdrop")).toHaveCount(1);
  await expect(page.locator("[data-pending-spacer]")).toHaveCount(1);
  await openLocalAccountSwitcher(page);
  await page
    .getByRole("button", { name: "Close DEV panel", exact: true })
    .click();
  const profile = page.locator("[data-volunteer-profile-link]").first();
  const path = new URL((await profile.getAttribute("href"))!, baseURL).pathname;
  let profileReads = 0;
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === path) profileReads++;
  });
  await profile.click();
  await expect(page).toHaveURL(new RegExp(path));
  expect(profileReads).toBe(1);
  expect(errors).toEqual([]);
});

test("a warmed dock destination opens without waiting for another HTML request", async ({
  page,
  baseURL,
}) => {
  await signInLocalAuthenticatorAccount(page.request, baseURL!);
  const warmed = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/applications" &&
      response.request().resourceType() === "fetch",
  );
  await page.goto("/events");
  await (await warmed).finished();
  // Cache insertion runs after the body has been consumed.
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
  let requests = 0;
  await page.route("**/applications", (route) => {
    requests++;
    return route.abort();
  });
  await page
    .getByRole("navigation", { name: "Quick navigation" })
    .getByRole("link", { name: /Applications/ })
    .click();
  await expect(page.locator("[data-volunteer-browser]")).toBeVisible();
  await expect(page).toHaveURL(/\/applications$/);
  expect(requests).toBe(0);
});

test("returning after sign-out discards warmed private screens and requires sign-in", async ({
  page,
  baseURL,
}) => {
  await signInLocalAuthenticatorAccount(page.request, baseURL!);
  const warmed = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/applications" &&
      response.request().resourceType() === "fetch",
  );
  await page.goto("/events");
  await (await warmed).finished();
  const signedOut = await page.request.post("/api/v1/auth/sign-out", {
    headers: { origin: baseURL! },
    data: {},
  });
  expect(signedOut.ok()).toBe(true);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await page
    .getByRole("navigation", { name: "Quick navigation" })
    .getByRole("link", { name: /Applications/ })
    .click();
  await expect(page).toHaveURL(/\/volunteer\/sign-in/);
  await expect(page.locator("[data-volunteer-browser]")).toHaveCount(0);
});
