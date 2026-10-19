import { expect, test, type Page } from "@playwright/test";
import {
  createLocalAccount,
  localApplicationReviewButton,
  localApplicationSaveIndicator,
} from "../helpers/local-account";
import {
  applicationDraftAnswersSchema,
  applicationDraftDiscardPrefix,
  applicationDraftStoragePrefix,
} from "../../src/data/application-draft";

const endpoint = "/api/v1/account/application-draft";
const button = "[data-draft-discard]";
const status = "[data-draft-discard-status]";
const key = (id: string) => `${applicationDraftStoragePrefix}${id}`;
const local = (page: Page, id: string) =>
  page.evaluate((key) => localStorage.getItem(key), key(id));
const account = async (page: Page) => (await page.request.get(endpoint)).json();
async function confirmDiscard(page: Page) {
  page.once("dialog", async (dialog) => {
    expect(dialog.message()).toBe(
      "Are you sure you want to permanently delete your application progress? This can’t be undone.",
    );
    await dialog.accept();
  });
  await page.locator(button).click();
}
async function discardAndReload(page: Page, retry = false) {
  await Promise.all([
    page.waitForEvent("domcontentloaded"),
    retry ? page.locator(button).click() : confirmDiscard(page),
  ]);
}
async function saved(page: Page, name: string) {
  await expect
    .poll(async () => (await account(page)).draft?.answers.firstName)
    .toBe(name);
}
async function expectDeleted(page: Page, id: string) {
  await expect(page.locator(button)).toBeEnabled();
  await expect(localApplicationReviewButton(page, "bottom")).toBeEnabled();
  await expect(page.locator(button)).not.toHaveAttribute("aria-busy", "true");
  await expect(page.locator(button).locator("svg")).toBeVisible();
  await expect(page.locator('[name="firstName"]')).toHaveValue("");
  await expect(page.locator('[name="firstName"]')).toBeEnabled();
  await expect(page.locator(status)).toBeHidden();
  await expect(localApplicationSaveIndicator(page)).toHaveText("");
  expect((await account(page)).draft).toBeNull();
  const backup = JSON.parse((await local(page, id))!);
  const emptyAnswers = applicationDraftAnswersSchema.parse({});
  expect(backup.answers).toEqual(emptyAnswers);
  expect(backup.savedAnswers).toEqual(emptyAnswers);
}

async function expectDiscardLoading(page: Page) {
  const discard = page.locator(button);
  await expect(discard).toHaveText("Discarding…");
  await expect(discard).toBeDisabled();
  await expect(localApplicationReviewButton(page, "bottom")).toBeDisabled();
  await expect(discard).toHaveAttribute("aria-busy", "true");
  await expect(discard.locator("svg")).toBeHidden();
  await expect(page.locator(status)).toBeHidden();
  await expect(page.locator("[data-draft-new]")).toBeHidden();
  expect(
    await discard.evaluate((element) => {
      const spinner = getComputedStyle(element, "::before");
      return {
        content: spinner.content,
        width: spinner.width,
        height: spinner.height,
        animation: spinner.animationName,
      };
    }),
  ).toEqual({
    content: '\"\"',
    width: "16px",
    height: "16px",
    animation: "volunteer-loading",
  });
}

test.beforeEach(({ baseURL }) => {
  test.skip(
    !baseURL?.startsWith("http://localhost:"),
    "Requires local development",
  );
});

for (const [layout, viewport] of [
  ["desktop", { width: 1280, height: 900 }],
  ["mobile", { width: 390, height: 844 }],
] as const) {
  test(`discard draft sits below and outside the whole form panel on ${layout}`, async ({
    page,
    baseURL,
  }) => {
    await page.setViewportSize(viewport);
    await createLocalAccount(page.request, baseURL!, false);
    await page.goto("/apply");

    const discard = page.locator(button);
    await expect(discard).toBeEnabled();
    await expect(discard).toHaveClass(/\bbtn-red\b/);
    await expect(discard).toHaveAccessibleName("Discard application draft");
    await expect(discard.locator("svg")).toBeVisible();
    await expect(discard.locator("svg")).toHaveAttribute("aria-hidden", "true");
    await expect(discard.locator("svg")).toHaveCSS("width", "20px");
    await expect(discard.locator("svg")).toHaveCSS("height", "20px");
    expect(
      await discard.evaluate((element) => {
        const form = document.querySelector("form[data-application]")!;
        const formBounds = form.getBoundingClientRect();
        const buttonBounds = element.getBoundingClientRect();
        return (
          !element.closest("form, .volunteer-panel") &&
          Boolean(
            form.compareDocumentPosition(element) &
            Node.DOCUMENT_POSITION_FOLLOWING,
          ) &&
          buttonBounds.top >= formBounds.bottom &&
          buttonBounds.left >= formBounds.left &&
          buttonBounds.right <= formBounds.right
        );
      }),
    ).toBe(true);
    await discard.scrollIntoViewIfNeeded();
    await expect(discard).toBeInViewport();
  });

  test(`confirmed discard automatically reloads an empty, editable application on ${layout}`, async ({
    page,
    baseURL,
  }) => {
    await page.setViewportSize(viewport);
    const { id } = await createLocalAccount(page.request, baseURL!, false);
    await page.goto("/apply#application-personal-info");
    await page.locator('[name="firstName"]').fill("Old application");
    await page.locator('[data-birth-date-part="day"]').fill("23");
    await page.locator('[name="medicalConditions"]').fill("Private old answer");
    await saved(page, "Old application");
    await page.locator('[name="phone"]').fill("Unsynced answer");

    await discardAndReload(page);

    await expect(page).toHaveURL("/apply");
    await expectDeleted(page, id);
    await page
      .locator("[data-account-profile]")
      .evaluate((form: HTMLFormElement) => form.reset());
    for (const part of ["day", "month", "year"])
      await expect(
        page.locator(`[data-birth-date-part="${part}"]`),
      ).toHaveValue("");
    await expect(page.locator('[name="medicalConditions"]')).toHaveValue("");
    await expect(page.locator('[name="phone"]')).toHaveValue("");
    await expect(page.locator("[data-draft-new]")).toBeHidden();
    await expect(page.locator("[data-application-review-step]")).toBeHidden();
    await page.locator('[name="firstName"]').fill("Fresh application");
    await saved(page, "Fresh application");
  });

  test(`discard shows only a busy button while deletion is pending on ${layout}`, async ({
    page,
    baseURL,
  }) => {
    await page.setViewportSize(viewport);
    const { id } = await createLocalAccount(page.request, baseURL!, false);
    await page.goto("/apply");
    await page.locator('[name="firstName"]').fill("Pending discard");
    await saved(page, "Pending discard");
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    await page.route(`**${endpoint}`, async (route) => {
      if (route.request().method() === "DELETE") await held;
      await route.continue();
    });
    try {
      await confirmDiscard(page);
      await expectDiscardLoading(page);
      await page.emulateMedia({ reducedMotion: "reduce" });
      expect(
        await page
          .locator(button)
          .evaluate(
            (element) => getComputedStyle(element, "::before").animationName,
          ),
      ).toBe("none");
      await Promise.all([page.waitForEvent("domcontentloaded"), release()]);
      await expectDeleted(page, id);
    } finally {
      release();
    }
  });

  test(`discard clears saved and unsynced answers without crypto.randomUUID on ${layout}`, async ({
    page,
    baseURL,
  }) => {
    await page.setViewportSize(viewport);
    const { id } = await createLocalAccount(page.request, baseURL!, false);
    // HTTP LAN addresses do not expose this secure-context API.
    await page.addInitScript(() => {
      Object.defineProperty(window.crypto, "randomUUID", {
        value: undefined,
        configurable: true,
      });
    });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto("/apply");
    await page.locator('[name="firstName"]').fill("Saved before discarding");
    await saved(page, "Saved before discarding");
    await page.locator('[name="medicalConditions"]').fill("Unsynced answer");

    await confirmDiscard(page);

    await expect(page.locator('[name="firstName"]')).toHaveValue("");
    await expectDeleted(page, id);
    await expect(page.locator('[name="medicalConditions"]')).toHaveValue("");
    await page.locator('[name="firstName"]').fill("Fresh application");
    await saved(page, "Fresh application");
    await discardAndReload(page);
    await expectDeleted(page, id);
    expect(errors).toEqual([]);
  });
}

test("retry uses the same busy button and hides the previous deletion error", async ({
  page,
  baseURL,
}) => {
  const { id } = await createLocalAccount(page.request, baseURL!, false);
  await page.goto("/apply");
  await page.locator('[name="firstName"]').fill("Retry discard");
  await saved(page, "Retry discard");
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  let attempts = 0;
  await page.route(`**${endpoint}`, async (route) => {
    if (route.request().method() !== "DELETE") return route.continue();
    if (++attempts <= 3) return route.fulfill({ status: 503 });
    await held;
    await route.continue();
  });
  try {
    await confirmDiscard(page);
    await expect(page.locator(status)).toContainText(
      "Account draft deletion is not confirmed",
    );
    await expect(page.locator(button)).toHaveText(
      "Retry discarding application draft",
    );
    await expect(page.locator(button)).toBeEnabled();
    await expect(page.locator(button)).not.toHaveAttribute("aria-busy", "true");
    await expect(page.locator(button).locator("svg")).toBeVisible();
    await expect(page.locator("[data-draft-new]")).toBeVisible();
    expect(attempts).toBe(3);

    await page.locator(button).click();

    await expectDiscardLoading(page);
    await Promise.all([page.waitForEvent("domcontentloaded"), release()]);
    await expectDeleted(page, id);
    expect(attempts).toBe(4);
  } finally {
    release();
  }
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
  await discardAndReload(page);
  await expectDeleted(page, id);
  await page.waitForTimeout(1200);
  expect(puts).toBe(0);
  await expectDeleted(page, id);
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
  await discardAndReload(page);
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
  await expectDeleted(page, id);
  expect(
    await page.evaluate((key) => localStorage.getItem(key), otherKey),
  ).toBe("another account's draft");
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
  await discardAndReload(page);
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

test("offline deletion resumes automatically when the connection returns", async ({
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
  await expect(localApplicationSaveIndicator(page)).toHaveText("Saving paused");
  expect(await local(page, id)).toBeNull();
  expect((await account(page)).draft.answers.firstName).toBe(
    "Still on account",
  );
  await page.unroute(`**${endpoint}`);
  await Promise.all([
    page.waitForEvent("domcontentloaded"),
    page.evaluate(() => window.dispatchEvent(new Event("online"))),
  ]);
  await expectDeleted(page, id);
});

test("an interrupted discard resumes on reload without another click or recovery message", async ({
  page,
  baseURL,
}) => {
  const { id } = await createLocalAccount(page.request, baseURL!, false);
  await page.goto("/apply");
  await page.locator('[name="firstName"]').fill("Interrupted discard");
  await saved(page, "Interrupted discard");
  await page.route(`**${endpoint}`, (route) =>
    route.request().method() === "DELETE" ? route.abort() : route.continue(),
  );
  await confirmDiscard(page);
  await expect(page.locator(status)).toContainText(
    "Account draft deletion is not confirmed",
  );
  await page.unroute(`**${endpoint}`);

  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route(`**${endpoint}`, async (route) => {
    if (route.request().method() === "DELETE") await held;
    await route.continue();
  });
  try {
    await page.reload();
    await expectDiscardLoading(page);
    await expect(page.locator('[name="firstName"]')).toHaveValue("");
    await expect(page.locator('[name="firstName"]')).toBeDisabled();
    expect(await local(page, id)).toBeNull();
    await Promise.all([page.waitForEvent("domcontentloaded"), release()]);
    await expectDeleted(page, id);
  } finally {
    release();
  }
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
  await discardAndReload(page);
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
    await route.abort();
  });
  await confirmDiscard(page);
  await expect(page.locator(status)).toContainText(
    "Reload to check your account",
  );
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

test("a lost DELETE success response is verified automatically without another click", async ({
  page,
  baseURL,
}) => {
  const { id } = await createLocalAccount(page.request, baseURL!, false);
  await page.goto("/apply");
  await page.locator('[name="firstName"]').fill("Lost deletion response");
  await saved(page, "Lost deletion response");
  let deletes = 0;
  let reads = 0;
  await page.route(`**${endpoint}`, async (route) => {
    if (route.request().method() === "GET") reads++;
    if (route.request().method() !== "DELETE") return route.continue();
    deletes++;
    await route.fetch();
    await route.abort();
  });
  await discardAndReload(page);
  await expectDeleted(page, id);
  expect(deletes).toBe(1);
  expect(reads).toBe(1);
});

for (const failure of ["request lost", "verification unavailable"] as const) {
  test(`discard retries the same request automatically when ${failure}`, async ({
    page,
    baseURL,
  }) => {
    const { id } = await createLocalAccount(page.request, baseURL!, false);
    await page.goto("/apply");
    // Even an empty server draft needs its generation changed to reject late saves.
    const originalGeneration = (await account(page)).generation;
    await page.locator('[name="firstName"]').fill("Retry automatically");
    const requests: unknown[] = [];
    let reads = 0;
    await page.route(`**${endpoint}`, async (route) => {
      if (route.request().method() === "GET") {
        reads++;
        return failure === "verification unavailable"
          ? route.abort()
          : route.continue();
      }
      if (route.request().method() !== "DELETE") return route.continue();
      requests.push(route.request().postDataJSON());
      if (requests.length === 1) {
        if (failure === "verification unavailable") await route.fetch();
        return route.abort();
      }
      await route.continue();
    });
    await discardAndReload(page);
    await expectDeleted(page, id);
    expect(requests).toHaveLength(2);
    expect(requests[0]).toEqual(requests[1]);
    expect(reads).toBe(1);
    expect((await account(page)).generation).not.toBe(originalGeneration);
  });
}

test("a lost deletion and verification response resumes automatically after reload", async ({
  page,
  baseURL,
}) => {
  const { id } = await createLocalAccount(page.request, baseURL!, false);
  await page.goto("/apply");
  await page.locator('[name="firstName"]').fill("All responses lost");
  await saved(page, "All responses lost");
  await page.route(`**${endpoint}`, async (route) => {
    if (route.request().method() === "DELETE") await route.fetch();
    await route.abort();
  });
  await confirmDiscard(page);
  await expect(page.locator(status)).toContainText(
    "Account draft deletion is not confirmed",
  );
  expect((await account(page)).draft).toBeNull();
  await page.unroute(`**${endpoint}`);
  await page.reload();
  await expectDeleted(page, id);
});

for (const changedState of ["account", "submission"] as const) {
  test(`deletion verification stops if the ${changedState} changed`, async ({
    page,
    baseURL,
  }) => {
    const { id } = await createLocalAccount(page.request, baseURL!, false);
    await page.goto("/apply");
    let deletes = 0;
    await page.route(`**${endpoint}`, async (route) => {
      if (route.request().method() === "DELETE") {
        deletes++;
        await route.fetch();
        return route.abort();
      }
      const response = await route.fetch();
      const state = await response.json();
      await route.fulfill({
        response,
        json: {
          ...state,
          ...(changedState === "account"
            ? { userId: "another-account" }
            : { submitted: true }),
        },
      });
    });
    await confirmDiscard(page);
    await expect(page.locator(status)).toContainText(
      changedState === "account"
        ? "Your account changed"
        : "A submitted application is never changed",
    );
    await expect(page.locator(button)).toBeEnabled();
    await expect(page.locator('[name="firstName"]')).toBeDisabled();
    const marker = await page.evaluate(
      (key) => JSON.parse(localStorage.getItem(key)!),
      `${applicationDraftDiscardPrefix}${id}`,
    );
    expect(marker.completed).toBe(false);
    expect(deletes).toBe(1);
    // Returning to the page must not automatically repeat a blocked deletion.
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    await page.waitForTimeout(700);
    expect(deletes).toBe(1);
  });
}

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
  await discardAndReload(page, true);
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
  await discardAndReload(page, true);
  await expectDeleted(page, id);
});
