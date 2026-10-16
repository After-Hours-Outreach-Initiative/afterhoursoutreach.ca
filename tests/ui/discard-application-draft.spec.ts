import { expect, test, type Page } from "@playwright/test";
import { createLocalAccount } from "../helpers/local-account";
import { applicationDraftStoragePrefix } from "../../src/data/application-draft";

const endpoint = "/api/v1/account/application-draft";
const button = "[data-draft-discard]";
const status = "[data-draft-discard-status]";
const key = (id: string) => `${applicationDraftStoragePrefix}${id}`;
const local = (page: Page, id: string) =>
  page.evaluate((key) => localStorage.getItem(key), key(id));
const account = async (page: Page) => (await page.request.get(endpoint)).json();
async function confirmDiscard(page: Page) {
  page.once("dialog", async (dialog) => {
    expect(dialog.message()).toContain("including unsynced answers");
    await dialog.accept();
  });
  await page.locator(button).click();
}
async function saved(page: Page, name: string) {
  await expect
    .poll(async () => (await account(page)).draft?.answers.firstName)
    .toBe(name);
}
async function expectDeleted(page: Page, id: string) {
  await expect(page.locator(status)).toContainText(
    "deleted from your account and this browser",
  );
  expect((await account(page)).draft).toBeNull();
  expect(await local(page, id)).toBeNull();
  await expect(page.locator('[name="firstName"]')).toHaveValue("");
}

test.beforeEach(({ baseURL }) => {
  test.skip(
    !baseURL?.startsWith("http://localhost:"),
    "Requires local development",
  );
});

test("cancel keeps account and unsynced browser answers without sending DELETE", async ({
  page,
  baseURL,
}) => {
  const { id } = await createLocalAccount(page.request, baseURL!, false);
  await page.goto("/apply");
  await page.locator('[name="firstName"]').fill("Account answer");
  await saved(page, "Account answer");
  await page.route(`**${endpoint}`, (route) =>
    route.request().method() === "PUT" ? route.abort() : route.continue(),
  );
  await page.locator('[name="firstName"]').fill("Unsynced answer");
  const backup = await local(page, id);
  let deletes = 0;
  page.on("request", (request) => {
    if (request.method() === "DELETE") deletes++;
  });
  page.once("dialog", (dialog) => dialog.dismiss());
  await page.locator(button).click();
  await expect(page.locator('[name="firstName"]')).toHaveValue(
    "Unsynced answer",
  );
  expect(await local(page, id)).toBe(backup);
  expect((await account(page)).draft.answers.firstName).toBe("Account answer");
  expect(deletes).toBe(0);
});

test("discard cancels a queued autosave before any answers reach the account", async ({
  page,
  baseURL,
}) => {
  const { id } = await createLocalAccount(page.request, baseURL!, false);
  await page.goto("/apply");
  let puts = 0;
  page.on("request", (request) => {
    if (request.url().endsWith(endpoint) && request.method() === "PUT") puts++;
  });
  await page.locator('[name="firstName"]').fill("Never synced");
  await confirmDiscard(page);
  await expectDeleted(page, id);
  await page.waitForTimeout(1200);
  expect(puts).toBe(0);
  expect(await local(page, id)).toBeNull();
});

test("discard clears unsynced answers across browser tabs and rejects a delayed first save", async ({
  page,
  context,
  baseURL,
}) => {
  const { id } = await createLocalAccount(page.request, baseURL!, false);
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let puts = 0;
  await page.route(`**${endpoint}`, async (route) => {
    if (route.request().method() === "PUT") {
      puts++;
      await held;
    }
    await route.continue();
  });
  await page.goto("/apply");
  await page.locator('[name="firstName"]').fill("Pending first save");
  await expect.poll(() => puts).toBe(1);
  await page
    .locator('[name="medicalConditions"]')
    .fill("Unsynced private answer");
  const otherKey = key("unrelated-account");
  await page.evaluate(
    (key) => localStorage.setItem(key, "another account's draft"),
    otherKey,
  );
  const sibling = await context.newPage();
  await sibling.route(`**${endpoint}`, (route) =>
    route.request().method() === "PUT" ? route.abort() : route.continue(),
  );
  await sibling.goto("/apply");
  await expect(sibling.locator('[name="firstName"]')).toHaveValue(
    "Pending first save",
  );
  await confirmDiscard(page);
  await expectDeleted(page, id);
  await expect(sibling.locator('[name="firstName"]')).toHaveValue("");
  await expect(sibling.locator('[name="firstName"]')).toBeDisabled();
  release();
  for (const tab of [page, sibling])
    await tab.evaluate(() => {
      window.dispatchEvent(new Event("pagehide"));
      window.dispatchEvent(new Event("focus"));
      window.dispatchEvent(new Event("online"));
    });
  await page.waitForTimeout(1200);
  expect(puts).toBe(1);
  expect((await account(page)).draft).toBeNull();
  expect(await local(page, id)).toBeNull();
  expect(
    await page.evaluate((key) => localStorage.getItem(key), otherKey),
  ).toBe("another account's draft");
  await page.reload();
  await expect(page.locator('[name="firstName"]')).toHaveValue("");
  await expect(page.locator('[name="medicalConditions"]')).toHaveValue("");
  await page.locator('[name="firstName"]').fill("Deliberate new draft");
  await saved(page, "Deliberate new draft");
  // The old stopped tab must not erase the new generation's browser backup.
  expect(JSON.parse((await local(page, id))!).answers.firstName).toBe(
    "Deliberate new draft",
  );
});

test("a successful save response arriving after deletion cannot restore cleared answers", async ({
  page,
  baseURL,
}) => {
  const { id } = await createLocalAccount(page.request, baseURL!, false);
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let savedOnServer = false;
  await page.route(`**${endpoint}`, async (route) => {
    if (route.request().method() !== "PUT") return route.continue();
    const response = await route.fetch();
    savedOnServer = true;
    await held;
    await route.fulfill({ response });
  });
  await page.goto("/apply");
  await page.locator('[name="firstName"]').fill("Late save response");
  await expect.poll(() => savedOnServer).toBe(true);
  await confirmDiscard(page);
  await expectDeleted(page, id);
  release();
  await page.waitForTimeout(1200);
  await expectDeleted(page, id);
  await page.evaluate(() =>
    (
      document.querySelector("form[data-application]") as HTMLFormElement
    ).reset(),
  );
  await expect(page.locator('[name="firstName"]')).toHaveValue("");
});

test("offline deletion reports partial failure, survives reload without restore, and retries", async ({
  page,
  baseURL,
}) => {
  const { id } = await createLocalAccount(page.request, baseURL!, false);
  await page.goto("/apply");
  await page.locator('[name="firstName"]').fill("Still on account");
  await saved(page, "Still on account");
  await page.route(`**${endpoint}`, (route) =>
    ["PUT", "DELETE"].includes(route.request().method())
      ? route.abort()
      : route.continue(),
  );
  await page.locator('[name="firstName"]').fill("Only on this device");
  await confirmDiscard(page);
  await expect(page.locator(status)).toContainText(
    "Account draft deletion is not confirmed",
  );
  await expect(page.locator(status)).toContainText(
    "This browser’s draft answers were deleted",
  );
  expect(await local(page, id)).toBeNull();
  expect((await account(page)).draft.answers.firstName).toBe(
    "Still on account",
  );
  await page.reload();
  await expect(page.locator('[name="firstName"]')).toHaveValue("");
  await expect(page.locator('[name="firstName"]')).toBeDisabled();
  expect(await local(page, id)).toBeNull();
  await page.unroute(`**${endpoint}`);
  await page.locator(button).click();
  await expectDeleted(page, id);
});

test("a stale account refresh response cannot restore a discarded draft", async ({
  page,
  baseURL,
}) => {
  const { id } = await createLocalAccount(page.request, baseURL!, false);
  await page.goto("/apply");
  await page.locator('[name="firstName"]').fill("Stale GET response");
  await saved(page, "Stale GET response");
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let refreshing = false;
  await page.route(`**${endpoint}`, async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    const response = await route.fetch();
    refreshing = true;
    await held;
    await route.fulfill({ response });
  });
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect.poll(() => refreshing).toBe(true);
  await confirmDiscard(page);
  await expectDeleted(page, id);
  release();
  await page.waitForTimeout(1200);
  await expectDeleted(page, id);
});

test("a failed discard retry cannot delete a newer draft and reload recovers", async ({
  page,
  baseURL,
}) => {
  const { id } = await createLocalAccount(page.request, baseURL!, false);
  await page.goto("/apply");
  await page.locator('[name="firstName"]').fill("Original draft");
  await saved(page, "Original draft");
  await page.route(`**${endpoint}`, async (route) => {
    if (route.request().method() !== "DELETE") return route.continue();
    await route.fetch();
    await route.abort();
  });
  await confirmDiscard(page);
  await expect(page.locator(status)).toContainText(
    "Account draft deletion is not confirmed",
  );
  const { generation } = await account(page);
  const newer = await page.request.put(endpoint, {
    headers: { origin: baseURL! },
    data: {
      userId: id,
      version: 1,
      revision: null,
      generation,
      answers: { firstName: "Newer deliberate draft" },
    },
  });
  expect(newer.ok()).toBe(true);
  await page.unroute(`**${endpoint}`);
  await page.locator(button).click();
  await expect(page.locator(status)).toContainText(
    "Reload to check your account",
  );
  expect((await account(page)).draft.answers.firstName).toBe(
    "Newer deliberate draft",
  );
  await page.reload();
  await expect(page.locator('[name="firstName"]')).toHaveValue(
    "Newer deliberate draft",
  );
  await expect(page.locator('[name="firstName"]')).toBeEnabled();
});

test("a lost DELETE success response can be retried safely", async ({
  page,
  baseURL,
}) => {
  const { id } = await createLocalAccount(page.request, baseURL!, false);
  await page.goto("/apply");
  await page.locator('[name="firstName"]').fill("Lost deletion response");
  await saved(page, "Lost deletion response");
  await page.route(`**${endpoint}`, async (route) => {
    if (route.request().method() !== "DELETE") return route.continue();
    await route.fetch();
    await route.abort();
  });
  await confirmDiscard(page);
  await expect(page.locator(status)).toContainText(
    "Account draft deletion is not confirmed",
  );
  expect((await account(page)).draft).toBeNull();
  await page.reload();
  await page.unroute(`**${endpoint}`);
  await page.locator(button).click();
  await expectDeleted(page, id);
});

test("browser storage deletion failures are not reported as complete and can be retried", async ({
  page,
  baseURL,
}) => {
  const { id } = await createLocalAccount(page.request, baseURL!, false);
  await page.goto("/apply");
  await page.locator('[name="firstName"]').fill("Storage failure answer");
  await saved(page, "Storage failure answer");
  await page.evaluate((key) => {
    const remove = Storage.prototype.removeItem;
    Storage.prototype.removeItem = function (name) {
      if (name === key) throw new DOMException("Unavailable", "SecurityError");
      return remove.call(this, name);
    };
    window.addEventListener("restore-storage", () => {
      Storage.prototype.removeItem = remove;
    });
  }, key(id));
  await confirmDiscard(page);
  await expect(page.locator(status)).toContainText(
    "We could not confirm deletion of this browser’s copy",
  );
  await expect(page.locator(status)).toContainText(
    "Your account draft was deleted",
  );
  expect(await local(page, id)).not.toBeNull();
  await page.evaluate(() => window.dispatchEvent(new Event("restore-storage")));
  await page.locator(button).click();
  await expectDeleted(page, id);
});

test("a stale account tab never deletes the newly signed-in account's local draft", async ({
  page,
  context,
  baseURL,
}) => {
  const first = await createLocalAccount(page.request, baseURL!, false);
  await page.goto("/apply");
  await page.locator('[name="firstName"]').fill("First account");
  await saved(page, "First account");
  const second = await createLocalAccount(page.request, baseURL!, false);
  const next = await context.newPage();
  await next.goto("/apply");
  await next.locator('[name="firstName"]').fill("Second account");
  await saved(next, "Second account");
  const secondBackup = await local(next, second.id);
  await confirmDiscard(page);
  await expect(page.locator(status)).toContainText(
    "Account draft deletion is not confirmed",
  );
  expect(await local(page, first.id)).toBeNull();
  expect(await local(next, second.id)).toBe(secondBackup);
  expect((await account(next)).draft.answers.firstName).toBe("Second account");
});

test("remote discard clears a dirty tab on refresh and stale device backup is not restored", async ({
  page,
  baseURL,
}) => {
  const { id } = await createLocalAccount(page.request, baseURL!, false);
  await page.goto("/apply");
  await page.locator('[name="firstName"]').fill("Old device draft");
  await saved(page, "Old device draft");
  await page.route(`**${endpoint}`, (route) =>
    route.request().method() === "PUT" ? route.abort() : route.continue(),
  );
  await page.locator('[name="firstName"]').fill("Unsynced old device answer");
  const backup = await local(page, id);
  const deleted = await page.request.delete(endpoint, {
    headers: { origin: baseURL! },
    data: { userId: id, generation: null, discardId: crypto.randomUUID() },
  });
  expect(deleted.ok()).toBe(true);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.locator(status)).toContainText(
    "discarded on another tab or device",
  );
  expect(await local(page, id)).toBeNull();
  // Simulate a device that was closed/offline when deletion happened.
  await page.goto("/privacy");
  await page.evaluate(({ key, backup }) => localStorage.setItem(key, backup!), {
    key: key(id),
    backup,
  });
  await page.goto("/apply");
  await expect(page.locator('[name="firstName"]')).toHaveValue("");
  await page.waitForTimeout(1200);
  expect((await account(page)).draft).toBeNull();
});

test("session expiry clears the browser copy but requires reauthentication for account deletion", async ({
  page,
  baseURL,
}) => {
  const { id } = await createLocalAccount(page.request, baseURL!, false);
  await page.goto("/apply");
  await page.locator('[name="firstName"]').fill("Revoked session draft");
  await saved(page, "Revoked session draft");
  await page.request.post("/api/v1/auth/sign-out", {
    headers: { origin: baseURL! },
    data: {},
  });
  await page
    .locator('[name="firstName"]')
    .fill("Unsynced revoked-session answer");
  await confirmDiscard(page);
  await expect(page.locator(status)).toContainText(
    "Sign in to the same account",
  );
  expect(await local(page, id)).toBeNull();
  await page.request.post("/api/v1/auth/dev/switch-user", {
    headers: { origin: baseURL! },
    data: { userId: id },
  });
  await page.locator(button).click();
  await expectDeleted(page, id);
});
