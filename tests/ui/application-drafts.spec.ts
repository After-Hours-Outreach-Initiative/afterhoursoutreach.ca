import { expect, test, type Page } from "@playwright/test";
import {
  createLocalAccount,
  fillApplicationField,
  localApplicationReviewButton,
  localApplicationSaveIndicator,
  reviewLocalApplication,
  sampleAnswers,
  submitLocalApplication,
} from "../helpers/local-account";
import {
  applicationDraftStoragePrefix,
  type ApplicationDraftAnswers,
} from "../../src/data/application-draft";

const endpoint = "/api/v1/account/application-draft";
const statusSelector = "[data-draft-status]";
const formSelector = "[data-account-profile]";

async function expectSaveTime(page: Page) {
  const { draft } = await (await page.request.get(endpoint)).json();
  const savedMessage = await page.evaluate((updatedAt) => {
    const savedDate = new Date(updatedAt);
    const date =
      savedDate.toDateString() === new Date().toDateString()
        ? ""
        : ` on ${new Intl.DateTimeFormat(undefined, {
            dateStyle: "medium",
          }).format(savedDate)}`;
    const time = new Intl.DateTimeFormat(undefined, {
      hour: "numeric",
      minute: "2-digit",
    }).format(savedDate);
    return `Last saved${date} at ${time}`;
  }, draft.updatedAt as number);
  await expect(page.locator("[data-draft-save-indicator]")).toHaveText([
    savedMessage,
    savedMessage,
    savedMessage,
  ]);
  await expect(
    localApplicationSaveIndicator(page).locator("svg"),
  ).toBeVisible();
}

async function expectDraftSaved(
  page: Page,
  answers: Partial<ApplicationDraftAnswers>,
) {
  await expect
    .poll(
      async () =>
        (await (await page.request.get(endpoint)).json()).draft?.answers,
    )
    .toEqual(expect.objectContaining(answers));
  await expect(page.locator("[data-draft-status-panel]")).toBeHidden();
  await expectSaveTime(page);
}

test.beforeEach(async ({ baseURL, page }) => {
  test.skip(
    !baseURL?.startsWith("http://localhost:"),
    "Requires local development",
  );
  const ip = crypto.getRandomValues(new Uint8Array(2));
  await page.setExtraHTTPHeaders({
    "cf-connecting-ip": `198.18.${ip[0]}.${ip[1]}`,
  });
});

for (const timezoneId of ["America/Vancouver", "Asia/Tokyo"]) {
  test(`save status adds the date after local midnight in ${timezoneId}`, async ({
    browser,
    baseURL,
  }) => {
    const context = await browser.newContext({ baseURL, timezoneId });
    try {
      const { id } = await createLocalAccount(context.request, baseURL!, false);
      const response = await context.request.put(endpoint, {
        headers: { origin: baseURL! },
        data: {
          userId: id,
          version: 1,
          revision: null,
          generation: null,
          answers: { firstName: "Saved before midnight" },
        },
      });
      expect(response.ok(), await response.text()).toBe(true);
      const { draft } = await response.json();
      const page = await context.newPage();
      const beforeMidnight = await page.evaluate((updatedAt) => {
        const date = new Date(updatedAt);
        date.setHours(23, 59, 59, 0);
        return date.getTime();
      }, draft.updatedAt as number);
      await page.clock.install({ time: new Date(beforeMidnight - 60_000) });
      await page.clock.pauseAt(new Date(beforeMidnight));
      await page.goto("/apply");
      await expect(localApplicationSaveIndicator(page)).toHaveText(
        /^Last saved at /,
      );
      await expectSaveTime(page);

      await page.clock.runFor(2000);

      await expect(localApplicationSaveIndicator(page)).toHaveText(
        /^Last saved on /,
      );
      await expectSaveTime(page);
      await page.reload();
      await expect(localApplicationSaveIndicator(page)).toHaveText(
        /^Last saved on /,
      );
      await expectSaveTime(page);
    } finally {
      await context.close();
    }
  });
}

test("browser drafts preserve incomplete answers through reload and closing the tab, then retry account saving", async ({
  page,
  context,
  baseURL,
}) => {
  const { id } = await createLocalAccount(page.request, baseURL!, false);
  // Keepalive requests on page close can outlive Playwright's request routing.
  // Simulate failure at fetch so even those writes cannot reach the server.
  await context.addInitScript(() => {
    const request = window.fetch.bind(window);
    let offline = true;
    window.addEventListener("draft-test-online", () => {
      offline = false;
      window.dispatchEvent(new Event("online"));
    });
    window.fetch = (input, options) => {
      if (
        offline &&
        String(input).endsWith("/api/v1/account/application-draft") &&
        options?.method === "PUT"
      )
        return Promise.reject(new TypeError("Simulated offline draft save"));
      return request(input, options);
    };
  });
  await page.goto("/apply");
  const form = page.locator(formSelector);
  await form.locator('[name="firstName"]').fill("  Unfinished name ");
  await form.locator('[name="phone"]').fill("123");
  await form.locator('[data-birth-date-part="day"]').fill("23");
  await form.locator('[data-birth-date-part="year"]').fill("19");
  await form.locator('[name="medicalConditions"]').fill("Sample medical draft");
  await form.locator('[name="teams"][value="medic"]').check();
  await form
    .locator('[data-date-input="certificationExpiry"] [data-native-date]')
    .fill("2030-02-14");
  await form.locator('[name="certifications"][value="other"]').check();
  await form.locator('[name="experience"]').fill("Unfinished other experience");
  await form.locator('[name="teams"][value="medic"]').uncheck();
  await expect
    .poll(() =>
      page.evaluate(
        (key) => JSON.parse(localStorage.getItem(key)!).answers.firstName,
        `${applicationDraftStoragePrefix}${id}`,
      ),
    )
    .toBe("  Unfinished name ");
  await page.reload();
  await expect(
    form.locator('[name="teams"][value="outreach"]'),
  ).not.toBeChecked();
  await expect(form.locator('[name="firstName"]')).toHaveValue(
    "  Unfinished name ",
  );
  await expect(form.locator('[name="phone"]')).toHaveValue("123");
  await expect(form.locator('[data-birth-date-part="day"]')).toHaveValue("23");
  await expect(form.locator('[data-birth-date-part="month"]')).toHaveValue("");
  await expect(form.locator('[data-birth-date-part="year"]')).toHaveValue("19");
  await expect(form.locator('[name="medicalConditions"]')).toHaveValue(
    "Sample medical draft",
  );
  await form.locator('[name="teams"][value="medic"]').check();
  await expect(
    form.locator('[data-date-input="certificationExpiry"] [data-native-date]'),
  ).toHaveValue("2030-02-14");
  await expect(
    form.locator('[name="certifications"][value="other"]'),
  ).toBeChecked();
  await expect(form.locator('[name="experience"]')).toHaveValue(
    "Unfinished other experience",
  );
  const reopened = await context.newPage();
  await page.close();
  await reopened.goto("/apply");
  await expect(reopened.locator('[name="firstName"]')).toHaveValue(
    "  Unfinished name ",
  );
  await expect(reopened.locator(statusSelector)).toContainText(
    "We could not connect",
  );
  await expect(reopened.locator("[data-draft-save-indicator]")).toHaveText(
    Array(3).fill("Couldn’t save to your account"),
  );
  await expect(
    localApplicationSaveIndicator(reopened).locator("svg"),
  ).toBeHidden();
  await reopened.evaluate(() =>
    window.dispatchEvent(new Event("draft-test-online")),
  );
  await expect(reopened.locator('[data-birth-date-part="day"]')).toHaveValue(
    "23",
  );
  await expect(reopened.locator('[data-birth-date-part="year"]')).toHaveValue(
    "19",
  );
  await expectDraftSaved(reopened, {
    teams: ["medic"],
    firstName: "  Unfinished name ",
    birthDate: '["23","","19"]',
    certificationExpiry: "2030-02-14",
  });
});

test("account drafts resume in a separate browser with no local storage and remain unsubmitted", async ({
  page,
  context,
  browser,
  baseURL,
}) => {
  await createLocalAccount(page.request, baseURL!, false);
  await page.goto("/apply");
  await page.locator('[name="firstName"]').fill("Different device");
  await fillApplicationField(page, "birthDate", "2020-01-01");
  await page.locator('[data-birth-date-part="month"]').fill("");
  await page.locator('[name="teams"][value="medic"]').check();
  const expiry = page.locator(
    '[data-date-input="certificationExpiry"] [data-native-date]',
  );
  await expiry.fill("2030-02-14");
  // Commit blur feedback before a pointer click can move its training target.
  await expiry.press("Tab");
  await page.locator('[name="training"][value="other"]').check();
  await page
    .locator('[name="otherTraining"]')
    .fill("Still finishing training answer");
  await expectDraftSaved(page, {
    firstName: "Different device",
    birthDate: '["01","","2020"]',
    certificationExpiry: "2030-02-14",
    training: ["other"],
    otherTraining: "Still finishing training answer",
  });
  const device = await browser.newContext({
    baseURL,
    storageState: { cookies: await context.cookies(), origins: [] },
    timezoneId: "America/Vancouver",
  });
  try {
    const resumed = await device.newPage();
    // The saved time must come from the account, not the device's current clock.
    await resumed.clock.setFixedTime(new Date(Date.now() + 3 * 60 * 60 * 1000));
    await resumed.goto("/apply");
    await expect(resumed.locator('[name="firstName"]')).toHaveValue(
      "Different device",
    );
    await expectSaveTime(resumed);
    await expect(
      resumed.locator('[name="teams"][value="outreach"]'),
    ).not.toBeChecked();
    await expect(
      resumed.locator('[name="teams"][value="medic"]'),
    ).toBeChecked();
    await expect(resumed.locator('[name="firstName"]')).toHaveAttribute(
      "required",
      "",
    );
    await expect(resumed.locator('[name="lastName"]')).toHaveAttribute(
      "required",
      "",
    );
    await expect(resumed.locator('[data-birth-date-part="day"]')).toHaveValue(
      "01",
    );
    await expect(resumed.locator('[data-birth-date-part="month"]')).toHaveValue(
      "",
    );
    await expect(resumed.locator('[data-birth-date-part="year"]')).toHaveValue(
      "2020",
    );
    await expect(resumed.locator('[name="birthDate"]')).toHaveValue("");
    await expect(
      resumed.locator(
        '[data-date-input="certificationExpiry"] [data-native-date]',
      ),
    ).toHaveValue("2030-02-14");
    await expect(resumed.locator('[name="certificationExpiry"]')).toHaveValue(
      "2030-02-14",
    );
    await expect(resumed.locator('[name="otherTraining"]')).toBeVisible();
    await expect(resumed.locator('[name="otherTraining"]')).toHaveValue(
      "Still finishing training answer",
    );
    await expect(
      resumed.locator('[name="codeOfConductAccepted"]'),
    ).not.toBeChecked();
    expect((await (await resumed.request.get(endpoint)).json()).submitted).toBe(
      false,
    );
    await resumed
      .locator('[name="firstName"]')
      .fill("Updated on another device");
    await expectDraftSaved(resumed, { firstName: "Updated on another device" });
    await resumed.reload();
    await expectSaveTime(resumed);
  } finally {
    await device.close();
  }
});

test("edits made during a pending save are backed up immediately and saved afterward", async ({
  page,
  baseURL,
}) => {
  const { id } = await createLocalAccount(page.request, baseURL!, false);
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  let releaseLatest!: () => void;
  const latestPending = new Promise<void>((resolve) => {
    releaseLatest = resolve;
  });
  let requests = 0;
  await page.route(`**${endpoint}`, async (route) => {
    if (route.request().method() === "PUT") {
      const attempt = ++requests;
      if (attempt === 1) await pending;
      if (attempt === 2) await latestPending;
    }
    await route.continue();
  });
  await page.goto("/apply");
  await expect(
    page.getByText("Your answers save automatically", { exact: false }),
  ).toHaveCount(0);
  await expect(page.locator("[data-draft-status-panel]")).toBeHidden();
  await expect(localApplicationSaveIndicator(page)).toHaveAttribute(
    "data-save-state",
    "idle",
  );
  await expect(localApplicationSaveIndicator(page)).toHaveText("");
  await page.locator('[name="firstName"]').fill("First version");
  await expect(
    localApplicationSaveIndicator(page).locator("[data-draft-save-message]"),
  ).toBeEmpty();
  await expect(localApplicationSaveIndicator(page).locator("svg")).toBeHidden();
  await expect.poll(() => requests).toBe(1);
  await expect(page.locator("[data-draft-status-panel]")).toBeHidden();
  await expect(
    localApplicationSaveIndicator(page).locator("[data-draft-save-message]"),
  ).toBeEmpty();
  await expect(localApplicationSaveIndicator(page).locator("svg")).toBeHidden();
  await page.locator('[name="firstName"]').fill("Latest version");
  expect(
    await page.evaluate(
      (key) => JSON.parse(localStorage.getItem(key)!).answers.firstName,
      `${applicationDraftStoragePrefix}${id}`,
    ),
  ).toBe("Latest version");
  release();
  await expect.poll(() => requests).toBe(2);
  await expect(localApplicationSaveIndicator(page)).toHaveAttribute(
    "data-save-state",
    "pending",
  );
  await expect(localApplicationSaveIndicator(page)).toHaveText("");
  await expect(localApplicationSaveIndicator(page).locator("svg")).toBeHidden();
  expect(
    (await (await page.request.get(endpoint)).json()).draft.answers.firstName,
  ).toBe("First version");
  releaseLatest();
  await expectDraftSaved(page, { firstName: "Latest version" });
});

test("last confirmed save status stays steady while editing", async ({
  page,
  baseURL,
}) => {
  await createLocalAccount(page.request, baseURL!, false);
  await page.goto("/apply");
  await page.locator('[name="firstName"]').fill("Confirmed answer");
  await expectDraftSaved(page, { firstName: "Confirmed answer" });
  const indicator = localApplicationSaveIndicator(page);
  const confirmedStatus = await indicator.innerText();

  let release!: () => void;
  const pending = new Promise<void>((resolve) => (release = resolve));
  let requests = 0;
  await page.route(`**${endpoint}`, async (route) => {
    if (route.request().method() === "PUT") {
      requests++;
      await pending;
    }
    await route.continue();
  });
  try {
    await page.locator('[name="firstName"]').fill("Pending answer");
    await expect(indicator).toHaveText(confirmedStatus);
    await expect.poll(() => requests).toBe(1);
    await expect(indicator).toHaveText(confirmedStatus);
    await expect(indicator).toHaveAttribute("data-save-state", "saved");
    await expect(indicator.locator("svg")).toBeVisible();
    await page.locator('[name="preferredName"]').fill("Another edit");
    await expect(indicator).toHaveText(confirmedStatus);
    release();
    await expectDraftSaved(page, {
      firstName: "Pending answer",
      preferredName: "Another edit",
    });
  } finally {
    release();
  }
});

for (const keepLocal of [true, false]) {
  test(`divergent device drafts require a choice: ${keepLocal ? "keep these answers" : "use account answers"}`, async ({
    page,
    baseURL,
  }) => {
    const { id } = await createLocalAccount(page.request, baseURL!, false);
    const localBirthDate = keepLocal ? "1991-05-23" : '["23","",""]';
    const accountBirthDate = keepLocal ? "1992-04-19" : '["","4","19"]';
    if (keepLocal) {
      const {
        heardAboutUs: _referral,
        certification: _certification,
        ...answers
      } = sampleAnswers;
      const seeded = await page.request.put(endpoint, {
        headers: { origin: baseURL! },
        data: { userId: id, version: 1, revision: null, answers },
      });
      expect(seeded.ok(), await seeded.text()).toBe(true);
    }
    await page.goto("/apply");
    await page.locator('[name="firstName"]').fill("Original draft");
    await expectDraftSaved(page, { firstName: "Original draft" });
    if (!keepLocal) await page.setViewportSize({ width: 390, height: 844 });
    if (keepLocal) {
      await reviewLocalApplication(page);
      await expect(
        page.locator("[data-application-review-step]"),
      ).toBeVisible();
      await page.goBack();
      await expect(page.locator("[data-application-review-step]")).toBeHidden();
    }
    await page.route(`**${endpoint}`, (route) =>
      route.request().method() === "PUT" ? route.abort() : route.continue(),
    );
    await page.locator('[name="firstName"]').fill("Local changes");
    if (keepLocal)
      await fillApplicationField(page, "birthDate", localBirthDate);
    else await page.locator('[data-birth-date-part="day"]').fill("23");
    const { draft } = await (await page.request.get(endpoint)).json();
    const remote = await page.request.put(endpoint, {
      headers: { origin: baseURL! },
      data: {
        userId: id,
        version: 1,
        revision: draft.revision,
        answers: {
          ...draft.answers,
          firstName: "Other device",
          birthDate: accountBirthDate,
        },
      },
    });
    expect(remote.ok(), await remote.text()).toBe(true);
    await page.reload();
    await expect(page.locator('[name="firstName"]')).toHaveValue(
      "Local changes",
    );
    const nameConflict = page.locator('[data-draft-conflict="firstName"]');
    const dateConflict = page.locator('[data-draft-conflict="birthDate"]');
    await expect(nameConflict).toBeVisible();
    await expect(dateConflict).toBeVisible();
    await expect(
      page
        .locator('[name="firstName"]')
        .locator("..")
        .locator("[data-draft-conflict]"),
    ).toHaveCount(1);
    await expect(
      page.locator('[data-date-input="birthDate"] [data-draft-conflict]'),
    ).toHaveCount(1);
    await expect(
      page.locator('[name="firstName"]'),
    ).toHaveAccessibleDescription(/Conflicting answers/);
    await expect(
      page.locator('[data-birth-date-part="day"]'),
    ).toHaveAccessibleDescription(/Conflicting answers/);
    expect(
      await page.locator("[id]").evaluateAll((elements) => {
        const ids = elements.map((element) => element.id);
        return ids.length === new Set(ids).size;
      }),
    ).toBe(true);
    const links = page.locator(
      '[data-application-progress-link][href="#application-personal-info"]',
    );
    for (const link of await links.all()) {
      await expect(link).toHaveAttribute("data-complete", "false");
      await expect(link).toHaveAttribute("data-conflicted", "true");
      await expect(link).toHaveAccessibleDescription("Conflicting answers");
    }
    await expect(page.locator(".volunteer-contents-progress-check")).toHaveCSS(
      "visibility",
      "hidden",
    );
    if (!keepLocal)
      await page.locator("[data-contents-menu] summary").first().click();
    const visibleLink = links.filter({ visible: true });
    await expect(
      visibleLink.locator(".volunteer-contents-completion-icon"),
    ).toBeHidden();
    await expect(
      visibleLink.locator(".volunteer-contents-conflict-icon"),
    ).toBeVisible();
    await expect(
      visibleLink.locator(".volunteer-contents-conflict-icon"),
    ).toHaveCSS("color", "rgb(250, 204, 21)");
    if (!keepLocal)
      await page.locator("[data-contents-menu] summary").first().click();
    if (keepLocal) {
      expect(
        await page
          .locator(formSelector)
          .evaluate((form: HTMLFormElement) => form.checkValidity()),
      ).toBe(true);
      await localApplicationReviewButton(page, "bottom").click();
      await expect(page.locator("[data-application-review-step]")).toBeHidden();
      await expect(
        nameConflict.getByRole("button", {
          name: "Keep my answers for first name",
          exact: true,
        }),
      ).toBeFocused();
      await page.goForward();
      await expect(page.locator("[data-application-review-step]")).toBeHidden();
      await expect(
        nameConflict.getByRole("button", {
          name: "Keep my answers for first name",
          exact: true,
        }),
      ).toBeFocused();
    }
    await expect(localApplicationSaveIndicator(page)).toHaveText(
      "Choose which answers to keep",
    );
    await expect(
      localApplicationSaveIndicator(page).locator("svg"),
    ).toBeHidden();
    await page.unroute(`**${endpoint}`);
    // Legal name and date of birth are separate conflicts, not a whole-form
    // overwrite choice. Resolve each explicitly.
    for (const field of ["first name", "birth date"])
      await page
        .getByRole("button", {
          name: `${keepLocal ? "Keep my answers" : "Use account answers"} for ${field}`,
          exact: true,
        })
        .click();
    await expect(page.locator("[data-draft-conflict]")).toHaveCount(0);
    await expect(
      page.locator('[name="firstName"]'),
    ).not.toHaveAccessibleDescription(/Conflicting answers/);
    for (const link of await links.all()) {
      await expect(link).toHaveAttribute("data-conflicted", "false");
      await expect(link).toHaveAttribute("data-complete", String(keepLocal));
    }
    await expect(page.locator('[name="firstName"]')).toHaveValue(
      keepLocal ? "Local changes" : "Other device",
    );
    if (!keepLocal)
      await page.locator("[data-contents-menu] summary").first().click();
    await expectDraftSaved(page, {
      firstName: keepLocal ? "Local changes" : "Other device",
      birthDate: keepLocal ? localBirthDate : accountBirthDate,
    });
    await expect(page.locator('[data-birth-date-part="day"]')).toHaveValue(
      keepLocal ? "23" : "",
    );
    await expect(page.locator('[data-birth-date-part="month"]')).toHaveValue(
      keepLocal ? "05" : "4",
    );
    await expect(page.locator('[data-birth-date-part="year"]')).toHaveValue(
      keepLocal ? "1991" : "19",
    );
    if (keepLocal) {
      await reviewLocalApplication(page);
      await expect(
        page.locator("[data-application-review-step]"),
      ).toBeVisible();
    }
  });
}

test("disabled or corrupted browser storage does not block server autosave", async ({
  page,
  baseURL,
}) => {
  const { id } = await createLocalAccount(page.request, baseURL!, false);
  await page.addInitScript((key) => {
    localStorage.setItem(key, "not valid JSON");
    Storage.prototype.setItem = () => {
      throw new DOMException("Storage unavailable", "SecurityError");
    };
  }, `${applicationDraftStoragePrefix}${id}`);
  await page.goto("/apply");
  await page
    .locator('[name="firstName"]')
    .fill("Saved without browser storage");
  await expect(page.locator(statusSelector)).toContainText(
    "Browser backup is unavailable",
  );
  await expectDraftSaved(page, { firstName: "Saved without browser storage" });
  await page.reload();
  await expect(page.locator('[name="firstName"]')).toHaveValue(
    "Saved without browser storage",
  );
});

test("switching accounts never restores or autosaves another account's answers", async ({
  page,
  baseURL,
}) => {
  const first = await createLocalAccount(page.request, baseURL!, false);
  await page.goto("/apply");
  await page.locator('[name="firstName"]').fill("First account answers");
  await expectDraftSaved(page, { firstName: "First account answers" });
  const second = await createLocalAccount(page.request, baseURL!, false);
  await page.locator('[name="firstName"]').fill("Stale tab changes");
  await expect(page.locator(statusSelector)).toContainText(
    "Sign in again or reload",
  );
  await expect(localApplicationSaveIndicator(page)).toHaveText(
    "Couldn’t save to your account",
  );
  await expect(localApplicationSaveIndicator(page).locator("svg")).toBeHidden();
  expect((await (await page.request.get(endpoint)).json()).draft).toBe(null);
  await page.goto("/apply");
  await expect(page.locator('[name="firstName"]')).toHaveValue("");
  await expect(page.locator(formSelector)).toHaveAttribute(
    "data-profile-user-id",
    second.id,
  );
  expect(
    await page.evaluate(
      (key) => JSON.parse(localStorage.getItem(key)!).answers.firstName,
      `${applicationDraftStoragePrefix}${first.id}`,
    ),
  ).toBe("Stale tab changes");
});

test("resuming requires fresh consent; submission clears drafts and course confirmation persists on the account", async ({
  page,
  baseURL,
}) => {
  const { id } = await createLocalAccount(page.request, baseURL!, false);
  await page.goto("/apply");
  const form = page.locator(formSelector);
  for (const [name, value] of Object.entries(sampleAnswers)) {
    if (typeof value !== "string") continue;
    if (name === "birthDate") {
      await fillApplicationField(form, name, value);
      continue;
    }
    const field = form.locator(`[name="${name}"]`);
    if (
      (await field.count()) &&
      (await field.isVisible()) &&
      (await field.isEditable())
    )
      await field.fill(value);
  }
  await form.locator('[name="heardAboutUsSources"][value="internet"]').check();
  await form.locator('[name="training"][value="none"]').check();
  await form.locator('[name="teams"][value="outreach"]').check();
  await reviewLocalApplication(page);
  await form.locator('[name="codeOfConductAccepted"]').check();
  const stored = await page.evaluate(
    (key) => localStorage.getItem(key),
    `${applicationDraftStoragePrefix}${id}`,
  );
  expect(stored).not.toContain("codeOfConductAccepted");
  await page.reload();
  await expect(localApplicationReviewButton(page)).toBeVisible();
  await expect(form.locator('[name="teams"][value="outreach"]')).toBeChecked();
  await expect(
    form.locator('[name="codeOfConductAccepted"]'),
  ).not.toBeChecked();
  await submitLocalApplication(page);
  await expect(page).toHaveURL(/\/events$/);
  expect(
    await page.evaluate(
      (key) => localStorage.getItem(key),
      `${applicationDraftStoragePrefix}${id}`,
    ),
  ).toBe(null);
  const result = await (await page.request.get(endpoint)).json();
  expect(result.draft).toBe(null);
  expect(result.submitted).toBe(true);
  const tracker = page.locator("[data-application-tracker]");
  const naloxoneStep = tracker.locator(
    '[data-application-progress-step="naloxone"]',
  );
  await expect(naloxoneStep).toHaveAttribute("data-state", "current");
  const reminder = page.locator("[data-naloxone-reminder]");
  await expect(reminder).toHaveClass(/volunteer-application-warning/);
  await expect(reminder).toHaveAttribute(
    "href",
    "/volunteer/account#account-naloxone",
  );
  await expect(page.locator("[data-naloxone-confirm]")).toHaveCount(0);
  await expect(page.locator("[data-naloxone-step]")).toHaveCount(0);
  await reminder.click();
  await expect(page).toHaveURL(/\/volunteer\/account#account-naloxone$/);
  const course = page.locator("[data-naloxone-step]");
  const checkbox = course.getByRole("checkbox", {
    name: "I confirm I have completed Naloxone 101.",
  });
  await expect(course).toHaveCount(1);
  await expect(course).toBeVisible();
  await expect(course.getByRole("heading")).toHaveCount(0);
  await expect(course).not.toHaveClass(/volunteer-panel/);
  await expect(course.getByRole("status").first()).toHaveText(
    "Naloxone 101: Not confirmed",
  );
  await expect(
    course.getByRole("link", { name: "Take Naloxone 101" }),
  ).toHaveAttribute("href", "https://towardtheheart.com/naloxone-course");
  await expect(checkbox).not.toBeChecked();
  await page.reload();
  await expect(checkbox).not.toBeChecked();
  // Reusing the same hash must still reveal the collapsed parent application.
  const applicationStep = tracker.locator(
    '[data-application-progress-step="form"]',
  );
  await applicationStep.locator(":scope > summary").click();
  await expect(course).toBeHidden();
  await reminder.click();
  await expect(course).toBeVisible();
  await expect(
    page.locator("[data-submitted-application] + [data-naloxone-step]"),
  ).toHaveCount(1);
  await expect(page.locator("[data-naloxone-confirm]")).toHaveCount(1);
  await checkbox.check();
  await course
    .getByRole("button", { name: "Confirm completion", exact: true })
    .click();
  await expect(course.getByRole("status")).toHaveText(
    "Naloxone 101 completed.",
  );
  await expect(naloxoneStep).toHaveAttribute("data-state", "complete");
  const confirmedAt = await naloxoneStep
    .locator("time")
    .getAttribute("datetime");
  expect(confirmedAt).toBeTruthy();
  await expect(reminder).toHaveCount(0);
  await expect(checkbox).toHaveCount(0);
  await expect(course.locator("form, a, button, input")).toHaveCount(0);
  await expect(course).toBeVisible();
  await page.reload();
  await expect(course).toHaveText("Naloxone 101 completed.");
  await expect(checkbox).toHaveCount(0);
  // The contents entry stays valid after the row is completed and refreshed.
  await applicationStep.locator(":scope > summary").click();
  await page
    .locator('.volunteer-contents-sidebar a[href="#account-naloxone"]')
    .click();
  await expect(course).toBeVisible();
  await expect(page.locator("[data-submitted-application]")).not.toContainText(
    "Naloxone 101",
  );
  await page.goto("/events");
  await expect(naloxoneStep).toHaveAttribute("data-state", "complete");
  await expect(naloxoneStep.locator("time")).toHaveAttribute(
    "datetime",
    confirmedAt!,
  );
  await expect(reminder).toHaveCount(0);
  await expect(page.locator("[data-naloxone-step]")).toHaveCount(0);
  await expect(page.locator("[data-naloxone-confirm]")).toHaveCount(0);
  await naloxoneStep.locator("summary").click();
  await expect(
    naloxoneStep.locator(".application-progress-content"),
  ).toHaveCount(0);
});

test("signing out removes synced browser drafts but retains the account draft", async ({
  page,
  baseURL,
}) => {
  const { id } = await createLocalAccount(page.request, baseURL!, false);
  await page.goto("/apply");
  await page.locator('[name="firstName"]').fill("Resume after signing out");
  await expectDraftSaved(page, { firstName: "Resume after signing out" });
  await page.locator("[data-account-menu] > summary").click();
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(page).toHaveURL(/\/volunteer\/sign-in$/);
  expect(
    await page.evaluate(
      (key) => localStorage.getItem(key),
      `${applicationDraftStoragePrefix}${id}`,
    ),
  ).toBe(null);
  const switched = await page.request.post("/api/v1/auth/dev/switch-user", {
    headers: { origin: baseURL! },
    data: { userId: id },
  });
  expect(switched.ok()).toBe(true);
  await page.goto("/apply");
  await expect(page.locator('[name="firstName"]')).toHaveValue(
    "Resume after signing out",
  );
});

test("expired sessions keep backing up new edits and resume syncing after sign-in", async ({
  page,
  baseURL,
}) => {
  const { id } = await createLocalAccount(page.request, baseURL!, false);
  await page.goto("/apply");
  await page.request.post("/api/v1/auth/sign-out", {
    headers: { origin: baseURL! },
    data: {},
  });
  await page
    .locator('[name="firstName"]')
    .fill("Before expired session warning");
  await expect(page.locator(statusSelector)).toContainText(
    "Sign in again or reload",
  );
  await page.locator('[name="firstName"]').fill("Edits after session expiry");
  expect(
    await page.evaluate(
      (key) => JSON.parse(localStorage.getItem(key)!).answers.firstName,
      `${applicationDraftStoragePrefix}${id}`,
    ),
  ).toBe("Edits after session expiry");
  const signedIn = await page.request.post("/api/v1/auth/dev/switch-user", {
    headers: { origin: baseURL! },
    data: { userId: id },
  });
  expect(signedIn.ok()).toBe(true);
  await page.getByRole("button", { name: "Retry saving" }).click();
  await expectDraftSaved(page, { firstName: "Edits after session expiry" });
});
