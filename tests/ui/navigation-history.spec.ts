import { expect, test, type Page } from "@playwright/test";
import {
  signInLocalAuthenticatorAccount,
  createLocalAccount,
  reviewLocalApplication,
  sampleAnswers,
} from "../helpers/local-account";
import { sortDirectory } from "../helpers/directory-sort";

test.use({ viewport: { width: 390, height: 844 }, reducedMotion: "reduce" });

async function tab(page: Page, name: string) {
  const dock = page.getByRole("navigation", { name: "Quick navigation" });
  await dock.getByRole("link", { name: new RegExp(`^${name}`) }).click();
  await expect(
    dock.getByRole("link", { name: new RegExp(`^${name}`) }),
  ).toHaveAttribute("aria-current", "page");
  await expect(page.locator("#main-content")).not.toHaveAttribute("inert");
}

async function expectTab(page: Page, name: string) {
  await expect(page.locator('.app-dock a[aria-current="page"]')).toContainText(
    name,
  );
  await expect(page.locator("#main-content")).not.toHaveAttribute("inert");
}

test("mobile Back and Forward restore directory filters and the correct dock screen", async ({
  page,
  baseURL,
}) => {
  await signInLocalAuthenticatorAccount(page.request, baseURL!);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/events");
  await tab(page, "Applications");
  const index = await page.evaluate(() => history.state.index);
  expect(typeof index).toBe("number");
  const search = page.locator("[data-volunteer-search]");
  await search.fill("no matching applicant for history");
  const filteredUrl = page.url();
  expect(await page.evaluate(() => history.state.index)).toBe(index);
  const filterRequests: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (
      url.pathname === "/applications" &&
      url.search &&
      ["fetch", "document"].includes(request.resourceType())
    )
      filterRequests.push(url.href);
  });
  await sortDirectory(page, "name", "asc");
  const sortedUrl = page.url();
  await page.goBack();
  await expect(page).toHaveURL(filteredUrl);
  await expect(search).toHaveValue("no matching applicant for history");
  await page.goForward();
  await expect(page).toHaveURL(sortedUrl);
  await expect(search).toHaveValue("no matching applicant for history");
  expect(filterRequests).toEqual([]);

  await tab(page, "Account");
  await page.goBack();
  await expectTab(page, "Applications");
  await expect(page).toHaveURL(sortedUrl);
  await expect(search).toHaveValue("no matching applicant for history");
  await page.goBack();
  await expect(page).toHaveURL(filteredUrl);
  await page.goBack();
  await expectTab(page, "Events");
  await expect(page.locator("[data-event-browser]")).toBeVisible();
  await page.goForward();
  await expectTab(page, "Applications");
  await expect(page).toHaveURL(filteredUrl);
  await page.goForward();
  await expect(page).toHaveURL(sortedUrl);
  await page.goForward();
  await expectTab(page, "Account");
  expect(errors).toEqual([]);
});

test("Back restores each visit's scroll position while dock taps retain tab memory", async ({
  page,
  baseURL,
}) => {
  await signInLocalAuthenticatorAccount(page.request, baseURL!);
  await page.goto("/volunteer/account");
  await page.evaluate(() => scrollTo({ top: 600, behavior: "instant" }));
  await expect.poll(() => page.evaluate(() => scrollY)).toBe(600);
  await expect.poll(() => page.evaluate(() => history.state.scrollY)).toBe(600);
  await tab(page, "Events");
  await tab(page, "Account");
  await expect.poll(() => page.evaluate(() => scrollY)).toBe(600);
  // Re-tapping this visit resets it, without changing the earlier visit's entry.
  await tab(page, "Account");
  await expect.poll(() => page.evaluate(() => scrollY)).toBe(0);
  await tab(page, "Events");
  await page.goBack();
  await expectTab(page, "Account");
  await expect.poll(() => page.evaluate(() => scrollY)).toBe(0);
  await page.goBack();
  await expectTab(page, "Events");
  await page.goBack();
  await expectTab(page, "Account");
  await expect.poll(() => page.evaluate(() => scrollY)).toBe(600);
  await page.goForward();
  await expectTab(page, "Events");
  await page.goForward();
  await expectTab(page, "Account");
  await expect.poll(() => page.evaluate(() => scrollY)).toBe(0);
});

test("calendar anchors keep local history when returning from another tab", async ({
  page,
  baseURL,
}) => {
  await signInLocalAuthenticatorAccount(page.request, baseURL!);
  await page.goto("/events");
  const initial = page.url();
  const index = await page.evaluate(() => history.state.index);
  await page.locator("[data-calendar-event]:visible").first().click();
  await expect.poll(() => new URL(page.url()).hash).not.toBe("");
  const selected = page.url();
  expect(await page.evaluate(() => history.state.index)).toBe(index);
  await tab(page, "Account");
  await page.goBack();
  await expectTab(page, "Events");
  await expect(page).toHaveURL(selected);
  await page
    .locator("[data-event-browser]")
    .evaluate((root) =>
      root.setAttribute("data-history-sentinel", "same-root"),
    );
  await page.goBack();
  await expect(page).toHaveURL(initial);
  await expect(page.locator("[data-event-browser]")).toHaveAttribute(
    "data-history-sentinel",
    "same-root",
  );
  await page.goForward();
  await expect(page).toHaveURL(selected);
  await expect(page.locator("[data-event-browser]")).toHaveAttribute(
    "data-history-sentinel",
    "same-root",
  );
});

test("Back and Forward cross detail pages without losing directory context", async ({
  page,
  baseURL,
}) => {
  await signInLocalAuthenticatorAccount(page.request, baseURL!);
  await page.goto("/volunteers?sort=name&direction=desc");
  const listUrl = page.url();
  const link = page.locator("[data-volunteer-profile-link]").first();
  const profileUrl = new URL((await link.getAttribute("href"))!, baseURL).href;
  await link.click();
  await expect(page).toHaveURL(profileUrl);
  await expect(page.locator("[data-volunteer-profile]")).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(listUrl);
  await expect(page.locator("[data-directory-ready]")).toBeVisible();
  await expect(page.locator('[name="sort"]:checked')).toHaveValue("name");
  await expect(page.locator('[name="direction"]:checked')).toHaveValue("desc");
  await page.goForward();
  await expect(page).toHaveURL(profileUrl);
  await expect(page.locator("[data-volunteer-profile]")).toBeVisible();
});

test("application review steps retain their own Back and Forward behavior", async ({
  page,
  baseURL,
}) => {
  const { id } = await createLocalAccount(page.request, baseURL!, false);
  const answers = Object.fromEntries(
    Object.entries(sampleAnswers).filter(
      ([key]) => !["heardAboutUs", "certification"].includes(key),
    ),
  );
  const saved = await page.request.put("/api/v1/account/application-draft", {
    headers: { origin: baseURL! },
    data: { userId: id, version: 1, revision: null, generation: null, answers },
  });
  expect(saved.ok(), await saved.text()).toBe(true);
  await page.goto("/apply");
  const review = page.locator("[data-application-review-step]");
  await reviewLocalApplication(page);
  await expect(review).toBeVisible();
  await page.goBack();
  await expect(review).toBeHidden();
  await page.goForward();
  await expect(review).toBeVisible();
  await page
    .getByRole("button", { name: "Back to answers", exact: true })
    .click();
  await expect(review).toBeHidden();
});

test("Back cancels an unfinished tab navigation before restoring local filters", async ({
  page,
  baseURL,
}) => {
  await signInLocalAuthenticatorAccount(page.request, baseURL!);
  await page.goto("/applications");
  const search = page.locator("[data-volunteer-search]");
  await search.fill("history cancellation");
  const filteredUrl = page.url();
  await sortDirectory(page, "name", "asc");
  const account = await page.request.get("/volunteer/account");
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let requested = false;
  let finished = false;
  await page.route("**/volunteer/account", async (route) => {
    requested = true;
    await held;
    try {
      await route.fulfill({ response: account });
    } catch {
      /* The cancelled fetch is expected. */
    } finally {
      finished = true;
    }
  });
  try {
    await page
      .getByRole("navigation", { name: "Quick navigation" })
      .getByRole("link", { name: "Account" })
      .click();
    await expect.poll(() => requested).toBe(true);
    await page.goBack();
    await expect(page).toHaveURL(filteredUrl);
    await expect(page.locator('[name="sort"]:checked')).toHaveValue("progress");
    await expectTab(page, "Applications");
    release();
    await expect.poll(() => finished).toBe(true);
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
    await expect(page).toHaveURL(filteredUrl);
    await expectTab(page, "Applications");
  } finally {
    release();
  }
});
