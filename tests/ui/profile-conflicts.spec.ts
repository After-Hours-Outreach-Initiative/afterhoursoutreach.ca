import { expect, test } from "@playwright/test";
import {
  createLocalAccount,
  sampleAnswers,
  reviewLocalApplication,
} from "../helpers/local-account";

test("profile different-field merges, explicit same-field choices, and pending typing survive", async ({
  page,
  context,
  baseURL,
}) => {
  await createLocalAccount(page.request, baseURL!);
  await page.goto("/volunteer/account");
  const other = await context.newPage();
  await other.goto("/volunteer/account");
  const form = page.locator("[data-account-profile]");
  const personal = form.getByRole("group", {
    name: "Personal info",
    exact: true,
  });
  const otherPersonal = other.getByRole("group", {
    name: "Personal info",
    exact: true,
  });
  await page.getByRole("button", { name: "Edit personal info" }).click();
  await form.locator('[name="phone"]').fill("604-555-0111");
  await other.getByRole("button", { name: "Edit personal info" }).click();
  await otherPersonal.locator('[name="pronouns"]').fill("remote pronouns");
  await otherPersonal
    .getByRole("button", { name: "Save", exact: true })
    .click();
  await expect(otherPersonal.locator("[data-profile-fields]")).toBeHidden();
  await personal.getByRole("button", { name: "Save", exact: true }).click();
  await expect(personal.locator("[data-profile-fields]")).toBeHidden();
  await expect(
    personal.locator('[data-profile-answer="pronouns"]'),
  ).toContainText("remote pronouns");
  await expect(personal.locator('[data-profile-answer="phone"]')).toContainText(
    "604-555-0111",
  );

  // Both editors now change the same field from an original baseline.
  await other.reload();
  await page.getByRole("button", { name: "Edit personal info" }).click();
  await form.locator('[name="phone"]').fill("604-555-0122");
  await other.getByRole("button", { name: "Edit personal info" }).click();
  await otherPersonal.locator('[name="phone"]').fill("604-555-0133");
  await otherPersonal
    .getByRole("button", { name: "Save", exact: true })
    .click();
  await expect(otherPersonal.locator("[data-profile-fields]")).toBeHidden();
  await personal.getByRole("button", { name: "Save", exact: true }).click();
  const conflict = form.getByRole("group", {
    name: "Conflicting profile answers",
  });
  await expect(conflict).toContainText("604-555-0122");
  await expect(conflict).toContainText("604-555-0133");
  await expect(
    personal.getByRole("button", { name: "Save", exact: true }),
  ).toBeDisabled();
  await conflict.getByRole("button", { name: "Keep my answers" }).click();

  let acknowledge!: () => void;
  const wait = new Promise<void>((resolve) => {
    acknowledge = resolve;
  });
  await page.route("**/api/v1/account/profile", async (route) => {
    const response = await route.fetch();
    await wait;
    await route.fulfill({ response });
  });
  try {
    await personal.getByRole("button", { name: "Save", exact: true }).click();
    await expect(form).toHaveAttribute("aria-busy", "true");
    await form.locator('[name="phone"]').fill("604-555-0144");
    acknowledge();
    await expect(form).not.toHaveAttribute("aria-busy");
    await expect(form.locator('[name="phone"]')).toHaveValue("604-555-0144");
    await expect(
      personal.getByRole("button", { name: "Save", exact: true }),
    ).toBeEnabled();
    await expect(
      personal.locator('[data-profile-answer="phone"]'),
    ).toContainText("604-555-0122");
  } finally {
    acknowledge();
    await page.unroute("**/api/v1/account/profile");
  }
  await personal.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByRole("button", { name: "Edit personal info" }).click();
  await expect(form.locator('[name="phone"]')).toHaveValue("604-555-0122");
});

test("draft offline merges retain local input and unresolved conflicts survive reconnect/reload", async ({
  page,
  baseURL,
}) => {
  const { id } = await createLocalAccount(page.request, baseURL!, false);
  const endpoint = "/api/v1/account/application-draft";
  await page.goto("/apply");
  await page.route(`**${endpoint}`, (route) =>
    route.request().method() === "PUT" ? route.abort() : route.continue(),
  );
  await page.locator('[name="phone"]').fill("604-555-0111");
  const remote = await page.request.put(endpoint, {
    headers: { origin: baseURL! },
    data: {
      userId: id,
      version: 1,
      revision: null,
      generation: null,
      answers: { pronouns: "remote pronouns" },
    },
  });
  expect(remote.ok(), await remote.text()).toBe(true);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.locator('[name="pronouns"]')).toHaveValue(
    "remote pronouns",
  );
  await expect(page.locator('[name="phone"]')).toHaveValue("604-555-0111");
  await expect(page.locator("[data-draft-conflict]")).toBeHidden();
  await page.unroute(`**${endpoint}`);
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect
    .poll(
      async () =>
        (await (await page.request.get(endpoint)).json()).draft?.answers.phone,
    )
    .toBe("604-555-0111");

  await page.route(`**${endpoint}`, (route) =>
    route.request().method() === "PUT" ? route.abort() : route.continue(),
  );
  await page.locator('[name="phone"]').fill("604-555-0122");
  await page.locator('[name="teams"][value="outreach"]').check();
  const state = await (await page.request.get(endpoint)).json();
  const changed = await page.request.put(endpoint, {
    headers: { origin: baseURL! },
    data: {
      userId: id,
      version: 1,
      revision: state.draft.revision,
      generation: state.generation,
      baseline: state.draft.answers,
      answers: {
        ...state.draft.answers,
        phone: "604-555-0133",
        teams: ["outreach", "medic"],
        certifications: ["other"],
        certificationExpiry: "2030-01-01",
        experience: "Account medical training",
      },
    },
  });
  expect(changed.ok(), await changed.text()).toBe(true);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  const conflict = page.locator('[data-draft-conflict="phone"]');
  await expect(conflict).toBeVisible();
  await page.reload();
  await expect(conflict).toBeVisible();
  await expect(page.locator('[name="phone"]')).toHaveValue("604-555-0122");
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect(conflict).toBeVisible();
  for (const section of [
    "personal-info",
    "team-interests",
    "training-and-safety",
  ])
    for (const link of await page
      .locator(
        `[data-application-progress-link][href="#application-${section}"]`,
      )
      .all())
      await expect(link).toHaveAttribute("data-conflicted", "true");
  await expect(page.locator("[data-medic-certifications]")).toBeHidden();
  const medicalConflict = page.locator(
    '[data-draft-conflict="certifications"]',
  );
  await expect(medicalConflict).toBeVisible();
  await page.unroute(`**${endpoint}`);
  await page
    .getByRole("button", { name: "Use account answers for phone", exact: true })
    .click();
  await expect(page.locator('[name="phone"]')).toHaveValue("604-555-0133");
  await expect(medicalConflict).toBeVisible();
  await medicalConflict
    .getByRole("button", {
      name: "Use account answers for certifications",
      exact: true,
    })
    .click();
  await expect(page.locator("[data-draft-conflict]")).toHaveCount(0);
  await expect(page.locator('[name="teams"][value="medic"]')).toBeChecked();
  await expect(
    page.locator('[name="certifications"][value="other"]'),
  ).toBeChecked();
  await expect(page.locator('[name="experience"]')).toHaveValue(
    "Account medical training",
  );
});

test("a lost first-submission response preserves input and retries cannot replace the profile", async ({
  page,
  baseURL,
}) => {
  const { id } = await createLocalAccount(page.request, baseURL!, false);
  const {
    heardAboutUs: _referral,
    certification: _certification,
    ...answers
  } = sampleAnswers;
  const seeded = await page.request.put("/api/v1/account/application-draft", {
    headers: { origin: baseURL! },
    data: { userId: id, version: 1, revision: null, generation: null, answers },
  });
  expect(seeded.ok(), await seeded.text()).toBe(true);
  await page.goto("/apply");
  await reviewLocalApplication(page);
  await page.locator('[name="codeOfConductAccepted"]').check();
  let sent: Record<string, unknown> | undefined;
  await page.route("**/api/v1/account/profile", async (route) => {
    sent = route.request().postDataJSON();
    const committed = await route.fetch();
    expect(committed.ok()).toBe(true);
    await route.abort();
  });
  await page
    .getByRole("button", { name: "Submit application", exact: true })
    .click();
  await expect(
    page.locator("[data-account-profile] [data-form-message]"),
  ).toContainText("connect");
  await page.unroute("**/api/v1/account/profile");
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.locator("[data-draft-status]")).toContainText(
    "already been submitted",
  );
  await expect(page).toHaveURL(/\/apply$/);
  await expect(page.locator('[name="phone"]')).toHaveValue(sampleAnswers.phone);
  const retry = await page.request.post("/api/v1/account/profile", {
    headers: { origin: baseURL! },
    data: { ...sent, phone: "604-555-0199" },
  });
  expect(retry.ok(), await retry.text()).toBe(true);
  const result = await retry.json();
  expect(result.alreadySubmitted).toBe(true);
  expect(result.answers.phone).toBe(sampleAnswers.phone);
});
