import { expect, test } from "@playwright/test";
import {
  createLocalAccount,
  openLocalAccountSwitcher,
  sampleAnswers,
} from "../helpers/local-account";
import {
  codeOfConductConfirmation,
  codeOfConductError,
  codeOfConductRules,
} from "../../src/data/code-of-conduct";
import { totpFromSetupKey } from "../helpers/totp";
import { inPlaceAction } from "../helpers/in-place-action";
import { registrationBirthDateError } from "../../src/data/registration";

test.beforeEach(async ({ page, baseURL }) => {
  test.skip(
    !baseURL?.startsWith("http://localhost:"),
    "Requires local development",
  );
  const ip = crypto.getRandomValues(new Uint8Array(2));
  await page.setExtraHTTPHeaders({
    "cf-connecting-ip": `198.18.${ip[0]}.${ip[1]}`,
  });
});

test("email validation follows native interaction timing without JavaScript", async ({
  browser,
  baseURL,
}) => {
  const context = await browser.newContext({
    baseURL,
    javaScriptEnabled: false,
  });
  try {
    const page = await context.newPage();
    await page.goto("/volunteer/sign-in");
    const form = page.locator("[data-email-request]");
    const email = form.getByRole("textbox", { name: "Email", exact: true });
    const error = form.locator("[data-error=email]");
    await expect(error).toBeHidden();
    await expect(email).not.toHaveCSS("border-top-color", "rgb(248, 113, 113)");
    await email.focus();
    await email.press("Tab");
    await expect(error).toBeHidden();
    await email.fill("not-an-email");
    await email.press("Tab");
    await expect(error).toBeVisible();
    await expect(email).toHaveCSS("border-top-color", "rgb(248, 113, 113)");
    await email.fill("valid@example.org");
    await expect(error).toBeHidden();
    await expect(email).not.toHaveCSS("border-top-color", "rgb(248, 113, 113)");
    await page.reload();
    await expect(error).toBeHidden();
    await form.getByRole("button", { name: "Continue with Email" }).click();
    await expect(error).toBeVisible();
    await expect(email).toBeFocused();
    await expect(page).toHaveURL(/\/volunteer\/sign-in$/);
  } finally {
    await context.close();
  }
});

test("email sign-in validates, loads, switches to code, and resets", async ({
  page,
}) => {
  let finishSending!: () => void;
  const sending = new Promise<void>((resolve) => {
    finishSending = resolve;
  });
  const emails: string[] = [];
  await page.route(
    "**/api/v1/auth/email-otp/send-verification-otp**",
    async (route) => {
      emails.push(route.request().postDataJSON().email);
      await sending;
      await route.fulfill({ json: { success: true } });
    },
  );
  const proofs: object[] = [];
  await page.route("**/api/v1/auth/sign-in/email-otp**", async (route) => {
    proofs.push(route.request().postDataJSON());
    await route.fulfill({
      status: 400,
      json: { message: "That code is incorrect or has expired." },
    });
  });
  await page.goto("/volunteer/sign-in");
  const emailForm = page.locator("[data-email-request]");
  const codeForm = page.locator("[data-email-code]");
  const emailInput = page.getByRole("textbox", {
    name: "Email",
    exact: true,
  });
  const continueButton = page.getByRole("button", {
    name: "Continue with Email",
  });
  await expect(emailForm).not.toHaveAttribute("novalidate");
  await expect(emailForm.locator("label")).toHaveText("Email");
  await expect(emailForm.locator("[data-error=email]")).toBeHidden();
  await continueButton.click();
  await expect(emailForm.locator("[data-error=email]")).toBeVisible();
  await expect(emailInput).toBeFocused();
  await expect(emailInput).toHaveCSS("border-top-color", "rgb(248, 113, 113)");
  await emailInput.fill("not-an-email");
  await expect(emailForm.locator("[data-error=email]")).toBeVisible();
  await expect(emailForm.locator("[data-error=email]")).toHaveText(
    "Enter a valid email address.",
  );
  await emailInput.fill("  First@example.org  ");
  await expect(emailForm.locator("[data-error=email]")).toBeHidden();
  await continueButton.click();
  const loading = page.getByRole("button", { name: "Sending email…" });
  await expect(loading).toBeDisabled();
  await expect(loading).toHaveAttribute("aria-busy", "true");
  await page
    .getByRole("button", { name: "Simulate successful delivery" })
    .click();
  await expect.poll(() => emails.length).toBe(1);
  await expect(loading).toBeDisabled();
  finishSending();
  await expect(emailForm).toBeVisible();
  await expect(emailInput).toBeVisible();
  await expect(emailInput).toHaveValue("first@example.org");
  await expect(emailInput).not.toBeEditable();
  await expect(continueButton).toBeHidden();
  await expect(codeForm).toBeVisible();
  const code = codeForm.locator('input[name="code"]');
  await expect(code).toHaveAccessibleName("Six-digit code");
  await expect(code).toBeFocused();
  await emailInput.press("Enter");
  await expect(emailForm).not.toHaveAttribute("aria-busy", "true");
  await expect(
    page.getByRole("button", { name: "Simulate successful delivery" }),
  ).toHaveCount(0);
  expect(emails).toEqual(["first@example.org"]);
  await code.fill("123");
  await page.getByRole("button", { name: "Sign in with code" }).click();
  await expect(codeForm.locator("[data-error=email-code]")).toBeVisible();
  await expect(codeForm.locator("[data-error=email-code]")).toHaveText(
    "Enter a six-digit code.",
  );
  expect(proofs).toEqual([]);
  await code.fill("123456");
  await page.getByRole("button", { name: "Sign in with code" }).click();
  await expect(codeForm.locator("[data-form-message]")).toHaveText(
    "That code is incorrect or has expired.",
  );
  expect(proofs).toEqual([{ email: "first@example.org", otp: "123456" }]);
  await page.getByRole("link", { name: "Use a different email" }).click();
  await expect(emailForm).toBeVisible();
  await expect(emailInput).toHaveValue("");
  await expect(emailInput).toBeEditable();
  await expect(emailInput).toBeFocused();
  await expect(continueButton).toBeEnabled();
  await expect(continueButton).toBeVisible();
  await expect(codeForm).toBeHidden();
  await expect(code).toHaveValue("");
  await expect(codeForm.locator('input[name="email"]')).toHaveValue("");
  await expect(codeForm.locator("[data-form-message]")).toBeHidden();
  await expect(emailForm.locator("[data-error=email]")).toBeHidden();
  await expect(
    page.getByRole("link", { name: "Use a different email" }),
  ).toBeHidden();
  await emailInput.fill("second@example.org");
  await continueButton.click();
  await page
    .getByRole("button", { name: "Simulate successful delivery" })
    .click();
  await expect(codeForm).toBeVisible();
  await expect(emailInput).toBeVisible();
  await expect(emailInput).toHaveValue("second@example.org");
  await expect(emailInput).not.toBeEditable();
  await expect(codeForm.locator('input[name="email"]')).toHaveValue(
    "second@example.org",
  );
  expect(emails).toEqual(["first@example.org", "second@example.org"]);
});

test("real email cooldowns and empty HTTP 429 responses are readable and retryable", async ({
  page,
  baseURL,
}) => {
  const email = `cooldown-${crypto.randomUUID()}@example.org`;
  const sent = await page.request.post(
    "/api/v1/auth/email-otp/send-verification-otp",
    {
      headers: { origin: baseURL! },
      data: { email, type: "sign-in" },
    },
  );
  expect(sent.status(), await sent.text()).toBe(200);
  await page.goto("/volunteer/sign-in");
  await page.getByRole("textbox", { name: "Email", exact: true }).fill(email);
  const button = page.getByRole("button", { name: "Continue with Email" });
  await button.click();
  await page
    .getByRole("button", { name: "Simulate successful delivery" })
    .click();
  const error = page.locator("[data-email-request] [data-form-message]");
  await expect(error).toHaveText(
    "Wait one minute before requesting another email.",
  );
  await expect(error).toHaveAttribute("role", "alert");
  await expect(button).toBeEnabled();
  await page.route(
    "**/api/v1/auth/email-otp/send-verification-otp**",
    (route) => route.fulfill({ status: 429, json: {} }),
  );
  await button.click();
  await page
    .getByRole("button", { name: "Simulate successful delivery" })
    .click();
  await expect(error).toHaveText(
    "Too many requests. Please wait before trying again.",
  );
  await expect(button).toBeEnabled();
  await expect(page.locator("[data-email-code]")).toBeHidden();
});

test("registration shows all required errors and saves after they are corrected", async ({
  page,
  baseURL,
}) => {
  const { email } = await createLocalAccount(page.request, baseURL!, false);
  await page.goto("/volunteer/register");
  const form = page.locator("[data-account-profile]");
  await expect(form.getByRole("heading", { level: 3 })).toHaveText([
    "Personal info",
    "Emergency contact",
    "About volunteering",
    "Training and safety",
    "Team interests",
    "Code of Conduct",
  ]);
  const emailInput = form.locator("input").first();
  await expect(emailInput).toHaveAttribute("type", "email");
  await expect(emailInput).toHaveValue(email);
  await expect(emailInput).not.toBeEditable();
  const emergencyContact = form.getByRole("group", {
    name: "Emergency contact",
    exact: true,
  });
  await expect(emergencyContact.locator("input")).toHaveCount(3);
  await expect(
    form
      .getByRole("group", { name: "About volunteering", exact: true })
      .locator("input, textarea"),
  ).toHaveCount(2);
  await expect(
    form
      .getByRole("group", { name: "Training and safety", exact: true })
      .locator("input, textarea"),
  ).toHaveCount(3);
  for (const field of [
    "emergencyName",
    "emergencyPhone",
    "emergencyRelationship",
  ])
    await expect(
      emergencyContact.locator(`input[name="${field}"]`),
    ).toHaveAttribute("required", "");
  const conduct = form.getByRole("region", {
    name: "Code of Conduct",
    exact: true,
  });
  await expect(conduct.getByRole("listitem")).toHaveText(
    codeOfConductRules.slice(0, 2),
  );
  const preview = conduct.locator(".volunteer-conduct-preview");
  const details = conduct.locator("details");
  expect(
    await preview.evaluate((element) => getComputedStyle(element).maskImage),
  ).toMatch(/linear-gradient\(.*40%/);
  await expect(conduct.locator("#code-of-conduct-more-rules")).toBeHidden();
  const toggle = conduct.locator("summary");
  const expectCollapseBelowRules = async () => {
    // Measure together: opening with the keyboard can also scroll the page.
    expect(
      await conduct.evaluate((element) => {
        const rules = element.querySelector("#code-of-conduct-more-rules")!;
        const control = element.querySelector("summary")!;
        return (
          control.getBoundingClientRect().top -
          rules.getBoundingClientRect().bottom
        );
      }),
    ).toBeGreaterThanOrEqual(0);
  };
  await expect(toggle).toHaveAccessibleName("Read all rules");
  await toggle.focus();
  await toggle.press("Enter");
  await expect(details).toHaveAttribute("open", "");
  await expect(conduct.getByRole("listitem")).toHaveText([
    ...codeOfConductRules,
  ]);
  expect(
    await preview.evaluate((element) => getComputedStyle(element).maskImage),
  ).toBe("none");
  await expect(toggle).toHaveAccessibleName("Show fewer rules");
  await expectCollapseBelowRules();
  await toggle.press("Space");
  await expect(details).not.toHaveAttribute("open");
  await expect(conduct.getByRole("listitem")).toHaveText(
    codeOfConductRules.slice(0, 2),
  );
  const confirmation = form.getByRole("checkbox", {
    name: codeOfConductConfirmation,
    exact: true,
  });
  await expect(confirmation).not.toBeChecked();
  await expect(confirmation).toBeVisible();
  await expect(confirmation).toHaveAttribute("required", "");
  await expect(
    form.getByRole("textbox", {
      name: "How did you hear about us?",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    form.getByRole("textbox", {
      name: "Why do you want to volunteer?",
      exact: true,
    }),
  ).toBeVisible();
  expect(
    await form.evaluate((element) => {
      const teams = element.querySelector(
        '[data-required-checkboxes="teams"]',
      )!;
      const rules = element.querySelector(".volunteer-code-of-conduct")!;
      const submit = element.querySelector('button[type="submit"]')!;
      return (
        Boolean(
          teams.compareDocumentPosition(rules) &
          Node.DOCUMENT_POSITION_FOLLOWING,
        ) &&
        Boolean(
          rules.compareDocumentPosition(submit) &
          Node.DOCUMENT_POSITION_FOLLOWING,
        )
      );
    }),
  ).toBe(true);
  await expect(form).not.toHaveAttribute("novalidate");
  const requests: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/v1/account/profile")
      requests.push(request.url());
  });
  await expect(
    page.getByRole("button", { name: "Complete registration" }),
  ).toBeEnabled();
  await expect(form.locator("[data-error]:visible")).toHaveCount(0);
  await page.getByRole("button", { name: "Complete registration" }).click();
  const required = form.locator(
    'input[required]:not([name="teams"]), textarea[required]',
  );
  const count = await required.count();
  expect(count).toBeGreaterThan(1);
  await expect(form.locator("[data-error]:visible")).toHaveCount(count + 1);
  for (const input of await required.all()) {
    expect(
      await input.evaluate((element) => element.matches(":user-invalid")),
    ).toBe(true);
    const id = await input.getAttribute("id");
    await expect(
      form.locator(`label[for="${id}"] .volunteer-required`),
    ).toHaveText("*");
  }
  await expect(form.locator("[data-error=teams]")).toHaveText(
    "Choose at least one team.",
  );
  await expect(form.locator("[data-error=teams]")).toBeVisible();
  await expect(
    page.getByRole("textbox", { name: "Full or preferred name", exact: true }),
  ).toBeFocused();
  await expect(form.locator("[data-error=pronouns]")).toBeHidden();
  await expect(form.locator("[data-error=medicalConditions]")).toBeHidden();
  await page
    .getByRole("textbox", { name: "Full or preferred name", exact: true })
    .fill("   ");
  await expect(form.locator("[data-error=name]")).toHaveText(
    "This field is required.",
  );
  await page
    .getByRole("textbox", { name: "Phone number", exact: true })
    .fill("invalid");
  await expect(form.locator("[data-error=phone]")).toContainText(
    "valid phone number",
  );
  await expect(form.locator("[data-error=phone]")).toBeVisible();
  await page.getByLabel(/^Date of birth/).fill("2999-01-01");
  await expect(form.locator("[data-error=birthDate]")).toContainText(
    "at least 19 years old",
  );
  await expect(form.locator("[data-error=birthDate]")).toBeVisible();
  expect(requests).toEqual([]);
  for (const [field, value] of Object.entries(sampleAnswers)) {
    if (field !== "teams")
      await form.locator(`[name="${field}"]`).fill(String(value));
  }
  await page.getByRole("button", { name: "Complete registration" }).click();
  await expect(form.getByLabel("Outreach", { exact: true })).toBeFocused();
  expect(requests).toEqual([]);
  await form.getByLabel("Outreach", { exact: true }).check();
  await expect(form.locator("[data-error=teams]")).toBeHidden();
  await page.setViewportSize({ width: 375, height: 812 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
  ).toBe(false);
  await page.getByRole("button", { name: "Complete registration" }).click();
  await expect(form.locator("[data-error=codeOfConductAccepted]")).toHaveText(
    codeOfConductError,
  );
  await expect(
    form.locator("[data-error=codeOfConductAccepted]"),
  ).toBeVisible();
  await expect(confirmation).toBeFocused();
  expect(requests).toEqual([]);
  await confirmation.press("Space");
  await expect(confirmation).toBeChecked();
  await expect(form.locator("[data-error]:visible")).toHaveCount(0);
  await expect(form.locator("[data-form-message]")).toBeHidden();
  await toggle.click();
  await expect(conduct.getByRole("listitem")).toHaveCount(
    codeOfConductRules.length,
  );
  await expect(confirmation).toBeVisible();
  await expectCollapseBelowRules();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
  ).toBe(false);
  await toggle.click();
  await expect(confirmation).toBeChecked();
  await page.getByRole("button", { name: "Complete registration" }).click();
  await expect(page).toHaveURL(/\/volunteer\/account$/);
  expect(requests).toHaveLength(1);
  await expect(
    page.getByRole("textbox", { name: "Full or preferred name", exact: true }),
  ).toHaveValue(sampleAnswers.name);
  await expect(
    page.getByRole("region", { name: "Code of Conduct", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.locator('[name="heardAboutUs"], [name="motivation"]'),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Save profile" }),
  ).toBeDisabled();
  // Editing reuses validation and identifies successful saves semantically.
  await page
    .getByRole("textbox", { name: "Full or preferred name", exact: true })
    .fill("Updated volunteer");
  await page.getByRole("button", { name: "Save profile" }).click();
  const saved = page.locator("[data-account-profile] [data-form-message]");
  await expect(saved).toHaveAttribute("data-message-kind", "success");
  await expect(
    page.getByRole("button", { name: "Save profile" }),
  ).toBeDisabled();
  await page.reload();
  await expect(
    page.getByRole("textbox", { name: "Full or preferred name", exact: true }),
  ).toHaveValue("Updated volunteer");
});

test("registration and profile edits block underage birth dates at the birthday boundary", async ({
  page,
  baseURL,
}) => {
  await createLocalAccount(page.request, baseURL!, false);
  await page.goto("/volunteer/register");
  const form = page.locator("[data-account-profile]");
  const birthDate = form.locator('[name="birthDate"]');
  const cutoff = (await birthDate.getAttribute("max"))!;
  const today = new Date();
  expect(cutoff.slice(0, 4)).toBe(String(today.getUTCFullYear() - 19));
  expect(cutoff.slice(5)).toBe(
    today.toISOString().slice(5, 10) === "02-29"
      ? "02-28"
      : today.toISOString().slice(5, 10),
  );
  for (const [field, value] of Object.entries(sampleAnswers)) {
    if (field !== "teams")
      await form.locator(`[name="${field}"]`).fill(String(value));
  }
  await form.getByLabel("Outreach", { exact: true }).check();
  await form.getByRole("checkbox", { name: codeOfConductConfirmation }).check();
  const requests: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/v1/account/profile")
      requests.push(request.url());
  });
  const younger = new Date(`${cutoff}T00:00:00Z`);
  younger.setUTCDate(younger.getUTCDate() + 1);
  const underage = younger.toISOString().slice(0, 10);
  for (const invalid of [underage, today.toISOString().slice(0, 10)]) {
    await birthDate.fill(invalid);
    await form.getByRole("button", { name: "Complete registration" }).click();
    await expect(birthDate).toBeFocused();
    await expect(form.locator("[data-error=birthDate]")).toBeVisible();
    await expect(form.locator("[data-error=birthDate]")).toHaveText(
      registrationBirthDateError,
    );
    expect(requests).toEqual([]);
    await expect(page).toHaveURL(/\/volunteer\/register$/);
  }
  await birthDate.fill(cutoff);
  await expect(form.locator("[data-error=birthDate]")).toBeHidden();
  await form.getByRole("button", { name: "Complete registration" }).click();
  await expect(page).toHaveURL(/\/volunteer\/account$/);
  expect(requests).toHaveLength(1);
  await expect(birthDate).toHaveValue(cutoff);
  await birthDate.fill(underage);
  await form.getByRole("button", { name: "Save profile" }).click();
  await expect(form.locator("[data-error=birthDate]")).toBeVisible();
  expect(requests).toHaveLength(1);
  await page.reload();
  await expect(birthDate).toHaveValue(cutoff);
});

test("the birth-date cutoff blocks native submission without JavaScript", async ({
  browser,
  baseURL,
}) => {
  const context = await browser.newContext({
    baseURL,
    javaScriptEnabled: false,
  });
  try {
    await createLocalAccount(context.request, baseURL!, false);
    const page = await context.newPage();
    await page.goto("/volunteer/register");
    const form = page.locator("[data-account-profile]");
    for (const [field, value] of Object.entries(sampleAnswers)) {
      if (field !== "teams")
        await form.locator(`[name="${field}"]`).fill(String(value));
    }
    // Without the checkbox-group script, each team retains its native constraint.
    for (const checkbox of await form.getByRole("checkbox").all()) {
      await checkbox.focus();
      await checkbox.press("Space");
    }
    const birthDate = form.locator('[name="birthDate"]');
    const cutoff = (await birthDate.getAttribute("max"))!;
    const younger = new Date(`${cutoff}T00:00:00Z`);
    younger.setUTCDate(younger.getUTCDate() + 1);
    await birthDate.fill(younger.toISOString().slice(0, 10));
    const submit = form.getByRole("button", { name: "Complete registration" });
    await submit.focus();
    await submit.press("Enter");
    await expect(birthDate).toBeFocused();
    await expect(form.locator("[data-error=birthDate]")).toBeVisible();
    await expect(page).toHaveURL(/\/volunteer\/register$/);
    await birthDate.fill(cutoff);
    expect(
      await birthDate.evaluate(
        (input: HTMLInputElement) => input.validity.valid,
      ),
    ).toBe(true);
  } finally {
    await context.close();
  }
});

test("profile saves enable only for changed answers and disable after saving", async ({
  page,
  baseURL,
}) => {
  const { email } = await createLocalAccount(page.request, baseURL!);
  await page.goto("/volunteer/account");
  const form = page.locator("[data-account-profile]");
  await expect(form.locator('input[type="email"]')).toHaveCount(0);
  const settings = page.locator(".volunteer-panel").filter({
    has: page.getByRole("heading", { name: "Account settings", exact: true }),
  });
  await expect(settings.getByText(email, { exact: true })).toBeVisible();
  const save = form.getByRole("button", { name: "Save profile" });
  const name = form.locator('[name="name"]');
  const requests: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/v1/account/profile")
      requests.push(request.url());
  });
  await expect(save).toBeDisabled();
  await expect(save).toHaveCSS("background-color", "rgb(39, 39, 42)");
  await name.press("Enter");
  await form.evaluate((element: HTMLFormElement) => element.requestSubmit());
  expect(requests).toEqual([]);

  for (const [field, changed] of [
    ["name", "Updated volunteer"],
    ["birthDate", "1996-05-13"],
    ["emergencyName", "Updated contact"],
    ["emergencyPhone", "604-555-0199"],
    ["emergencyRelationship", "Sibling"],
    ["medicalConditions", "Updated safety answer"],
  ] as const) {
    const input = form.locator(`[name="${field}"]`);
    await input.fill(changed);
    await expect(save).toBeEnabled();
    await input.fill(sampleAnswers[field]);
    await expect(save).toBeDisabled();
  }
  const medic = form.getByLabel("Medic", { exact: true });
  await medic.focus();
  await medic.press("Space");
  await expect(save).toBeEnabled();
  await medic.press("Space");
  await expect(save).toBeDisabled();
  await name.fill(` ${sampleAnswers.name} `);
  await expect(save).toBeDisabled();
  await name.fill("Reset this draft");
  await expect(save).toBeEnabled();
  await form.evaluate((element: HTMLFormElement) => element.reset());
  await expect(save).toBeDisabled();

  await name.fill("");
  await save.click();
  await expect(form.locator("[data-error=name]")).toHaveText(
    "This field is required.",
  );
  await expect(form.locator("[data-error=name]")).toBeVisible();
  expect(requests).toEqual([]);
  await name.fill(sampleAnswers.name);
  await expect(save).toBeDisabled();
  await name.fill("Updated volunteer");
  await expect(save).toBeEnabled();
  await save.click();
  await expect(form.locator("[data-form-message]")).toHaveAttribute(
    "data-message-kind",
    "success",
  );
  await expect(save).toBeDisabled();
  expect(requests).toHaveLength(1);
  await name.fill(sampleAnswers.name);
  await expect(save).toBeEnabled();
  await name.fill("Updated volunteer");
  await expect(save).toBeDisabled();
  await page.reload();
  await expect(name).toHaveValue("Updated volunteer");
  await expect(save).toBeDisabled();
});

test("team selection requires any one checkbox and restores constraints on reset", async ({
  page,
  baseURL,
}) => {
  await createLocalAccount(page.request, baseURL!);
  await page.goto("/volunteer/account");
  const form = page.locator("[data-account-profile]");
  const error = form.locator("[data-error=teams]");
  const outreach = form.getByLabel("Outreach", { exact: true });
  const medic = form.getByLabel("Medic", { exact: true });
  const requests: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/v1/account/profile")
      requests.push(request.url());
  });
  await expect(error).toBeHidden();
  await outreach.uncheck();
  await form.getByRole("button", { name: "Save profile" }).click();
  await expect(error).toBeVisible();
  await expect(outreach).toBeFocused();
  expect(requests).toEqual([]);
  await medic.check();
  await expect(error).toBeHidden();
  await expect(form.locator('[name="teams"][required]')).toHaveCount(0);
  await outreach.check();
  await medic.uncheck();
  await expect(error).toBeHidden();
  await outreach.uncheck();
  await expect(form.locator('[name="teams"][required]')).toHaveCount(3);
  await form.evaluate((element: HTMLFormElement) => element.reset());
  await expect(outreach).toBeChecked();
  await expect(form.locator('[name="teams"][required]')).toHaveCount(0);
  await expect(error).toBeHidden();
  await expect(
    form.getByRole("button", { name: "Save profile" }),
  ).toBeDisabled();
  expect(requests).toEqual([]);
});

test("email changes verify the new address in place and preserve unsaved profile answers", async ({
  page,
  baseURL,
}) => {
  const { id, email } = await createLocalAccount(page.request, baseURL!);
  await page.goto("/volunteer/account");
  const name = page.getByRole("textbox", {
    name: "Full or preferred name",
    exact: true,
  });
  await name.fill("Unsaved email-change draft");
  const request = page.locator("[data-email-change-request]");
  const confirm = page.locator("[data-email-change-confirm]");
  await request.getByRole("button", { name: "Send verification code" }).click();
  await expect(request.locator("[data-error=new-email]")).toBeVisible();
  await expect(confirm).toBeHidden();
  const newEmail = `changed-${crypto.randomUUID()}@example.org`;
  await request.getByLabel("New email address").fill(newEmail);
  await request.getByRole("button", { name: "Send verification code" }).click();
  await page.getByRole("button", { name: "Fill verification code" }).click();
  await expect(confirm).toBeVisible();
  const code = confirm.getByLabel("Verification code");
  await expect(code).toHaveValue(/^\d{6}$/);
  const proof = await code.inputValue();
  await expect(
    page.locator("[data-email-settings] [data-account-email]"),
  ).toHaveText(email);
  await code.fill("123");
  await confirm.getByRole("button", { name: "Confirm email change" }).click();
  await expect(confirm.locator("[data-error=email-change-code]")).toBeVisible();
  await code.fill(proof === "000000" ? "000001" : "000000");
  await confirm.getByRole("button", { name: "Confirm email change" }).click();
  await expect(confirm.locator("[data-form-message]")).toHaveAttribute(
    "role",
    "alert",
  );
  await expect(
    confirm.getByRole("button", { name: "Confirm email change" }),
  ).toBeEnabled();
  await expect(name).toHaveValue("Unsaved email-change draft");
  await code.fill(proof);
  await inPlaceAction(page, {
    endpoint: "/api/v1/auth/email-otp/change-email",
    form: confirm,
    trigger: () =>
      confirm.getByRole("button", { name: "Confirm email change" }).click(),
    updated: () => expect(confirm).toBeHidden(),
    loadingLabel: "Changing email…",
  });
  await expect(page.locator("[data-account-email]")).toHaveText([
    newEmail,
    newEmail,
  ]);
  await expect(request.locator("[data-form-message]")).toHaveAttribute(
    "data-message-kind",
    "success",
  );
  await expect(name).toHaveValue("Unsaved email-change draft");
  await expect(
    page.getByRole("button", { name: "Save profile" }),
  ).toBeEnabled();
  await page.reload();
  await expect(
    page.locator("[data-email-settings] [data-account-email]"),
  ).toHaveText(newEmail);
  await expect(name).toHaveValue(sampleAnswers.name);
  const current = await (
    await page.request.get("/api/v1/auth/get-session")
  ).json();
  expect(current.user.id).toBe(id);
  expect(current.user.email).toBe(newEmail);
});

test("failed email-change requests remain retryable without changing the account address", async ({
  page,
  baseURL,
}) => {
  const { email } = await createLocalAccount(page.request, baseURL!);
  await page.goto("/volunteer/account");
  const request = page.locator("[data-email-change-request]");
  await request.getByLabel("New email address").fill("failed@example.org");
  await page.route("**/api/v1/auth/email-otp/request-email-change", (route) =>
    route.fulfill({
      status: 503,
      json: { message: "We could not send the email. Try again later." },
    }),
  );
  const button = request.getByRole("button", {
    name: "Send verification code",
  });
  await button.click();
  await expect(request.locator("[data-form-message]")).toHaveText(
    "We could not send the email. Try again later.",
  );
  await expect(button).toBeEnabled();
  await expect(request.getByLabel("New email address")).toHaveValue(
    "failed@example.org",
  );
  await expect(page.locator("[data-email-change-confirm]")).toBeHidden();
  await expect(
    page.locator("[data-email-settings] [data-account-email]"),
  ).toHaveText(email);
});

test("event editor shows native number and URL errors without submitting", async ({
  page,
}) => {
  await page.goto("/volunteer");
  const profiles = await openLocalAccountSwitcher(page);
  await profiles
    .locator('[data-switch-user="local-fixture-user-robin"]')
    .click();
  await page.getByRole("button", { name: "Add an event", exact: true }).click();
  const dialog = page.getByRole("dialog", {
    name: "Add an event",
    exact: true,
  });
  const form = dialog.locator("[data-event-save]");
  const requests: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/v1/events/action")
      requests.push(request.url());
  });
  await expect(form.locator("[data-error]:visible")).toHaveCount(0);
  await form.getByLabel("Start date and time").fill("2030-01-01T20:00");
  await form
    .getByLabel("Meeting point", { exact: true })
    .fill("Test meeting point");
  const spots = form.getByLabel("Volunteer spots");
  const map = form.getByLabel("Map link (optional)");
  await spots.fill("0");
  await map.fill("not-a-url");
  await form.getByRole("button", { name: "Save event" }).click();
  await expect(form.locator("[data-error$='-spots']")).toBeVisible();
  await expect(form.locator("[data-error$='-meetingPointUrl']")).toBeVisible();
  await expect(spots).toBeFocused();
  await expect(spots).toHaveCSS("border-top-color", "rgb(248, 113, 113)");
  expect(requests).toEqual([]);
  for (const invalid of ["101", "1.5"]) {
    await spots.fill(invalid);
    await form.getByRole("button", { name: "Save event" }).click();
    await expect(form.locator("[data-error$='-spots']")).toBeVisible();
    expect(requests).toEqual([]);
  }
  await spots.fill("8");
  await map.fill("https://example.org/map");
  await expect(form.locator("[data-error]:visible")).toHaveCount(0);
  expect(requests).toEqual([]);
});

test("failed profile saves keep unsaved changes retryable", async ({
  page,
  baseURL,
}) => {
  await createLocalAccount(page.request, baseURL!);
  await page.goto("/volunteer/account");
  const form = page.locator("[data-account-profile]");
  const save = form.getByRole("button", { name: "Save profile" });
  const name = form.locator('[name="name"]');
  await page.route("**/api/v1/account/profile", (route) =>
    route.fulfill({
      status: 503,
      json: { message: "Your profile is temporarily unavailable." },
    }),
  );
  await name.fill("Retry this profile");
  await save.click();
  await expect(form.locator("[data-form-message]")).toHaveText(
    "Your profile is temporarily unavailable.",
  );
  await expect(save).toBeEnabled();
  await expect(name).toHaveValue("Retry this profile");
  await name.fill(sampleAnswers.name);
  await expect(save).toBeDisabled();
  await name.fill("Retry this profile");
  await page.unroute("**/api/v1/account/profile");
  await save.click();
  await expect(form.locator("[data-form-message]")).toHaveAttribute(
    "data-message-kind",
    "success",
  );
  await expect(save).toBeDisabled();
});

test("edits made during a profile save remain unsaved", async ({
  page,
  baseURL,
}) => {
  await createLocalAccount(page.request, baseURL!);
  await page.goto("/volunteer/account");
  const form = page.locator("[data-account-profile]");
  const save = form.getByRole("button", { name: "Save profile" });
  const name = form.locator('[name="name"]');
  let finishSaving!: () => void;
  const saving = new Promise<void>((resolve) => {
    finishSaving = resolve;
  });
  await page.route("**/api/v1/account/profile", async (route) => {
    await saving;
    await route.continue();
  });
  try {
    await name.fill("First saved name");
    await save.click();
    await expect(form).toHaveAttribute("aria-busy", "true");
    await expect(save).toBeDisabled();
    await name.fill("Second unsaved name");
    await expect(save).toBeDisabled();
    finishSaving();
    await expect(form).not.toHaveAttribute("aria-busy");
    await expect(form.locator("[data-form-message]")).toHaveAttribute(
      "data-message-kind",
      "success",
    );
    await expect(save).toBeEnabled();
    await name.fill("First saved name");
    await expect(save).toBeDisabled();
    await name.fill("Second unsaved name");
    await save.click();
    await expect(save).toBeDisabled();
    await expect(form).not.toHaveAttribute("aria-busy");
    await page.reload();
    await expect(name).toHaveValue("Second unsaved name");
    await expect(save).toBeDisabled();
  } finally {
    finishSaving();
  }
});

test("authenticator setup and sign-in show native inline code errors", async ({
  page,
  baseURL,
}) => {
  await createLocalAccount(page.request, baseURL!);
  await page.goto("/volunteer/account");
  const name = page.getByRole("textbox", {
    name: "Full or preferred name",
    exact: true,
  });
  await name.fill("Unsaved authenticator draft");
  await page.getByRole("button", { name: "Set up an authenticator" }).click();
  const setup = page.locator("[data-confirm-factor]");
  await expect(setup).toBeVisible();
  await expect(setup.locator("[data-error=factor-setup-code]")).toBeHidden();
  await page.getByRole("button", { name: "Verify and enable" }).click();
  await expect(setup.locator("[data-error=factor-setup-code]")).toBeVisible();
  const code = setup.locator('input[name="code"]');
  await code.fill("123");
  await expect(setup.locator("[data-error=factor-setup-code]")).toHaveText(
    "Enter a six-digit code.",
  );
  await expect(setup.locator("[data-error=factor-setup-code]")).toBeVisible();
  const key = (await page.locator("[data-factor-key]").textContent())!;
  await code.fill(totpFromSetupKey(key));
  await inPlaceAction(page, {
    endpoint: "/api/v1/auth/two-factor/verify-totp",
    form: setup,
    trigger: () =>
      page.getByRole("button", { name: "Verify and enable" }).click(),
    updated: () =>
      expect(
        page.getByText("Your authenticator is enabled.", { exact: false }),
      ).toBeVisible(),
    loadingLabel: "Verifying…",
  });
  await expect(name).toHaveValue("Unsaved authenticator draft");
  await expect(page.locator("[data-account-sessions]")).toContainText(
    "This device",
  );
  await page.locator("[data-account-menu] summary").click();
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(page).toHaveURL(/\/volunteer\/sign-in$/);
  await page.goto("/volunteer/sign-in?second-factor=1");
  const challenge = page.locator("[data-second-factor]");
  await expect(challenge).not.toHaveAttribute("novalidate");
  await expect(challenge).toBeVisible();
  await expect(page.locator("[data-email-request]")).toBeHidden();
  await page.getByRole("button", { name: "Verify code", exact: true }).click();
  await expect(challenge.locator("[data-error=second-factor-code]")).toHaveText(
    "Enter an authenticator or backup code.",
  );
  await expect(
    challenge.locator("[data-error=second-factor-code]"),
  ).toBeVisible();
  await expect(challenge.locator('input[name="code"]')).toBeFocused();
  await expect(challenge.locator(".volunteer-required")).toHaveText("*");
});

test("private pages make no third-party requests and remain usable on mobile", async ({
  page,
  baseURL,
}) => {
  await page.setViewportSize({ width: 375, height: 812 });
  const external: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).origin !== new URL(baseURL!).origin)
      external.push(request.url());
  });
  for (const path of ["/volunteer", "/privacy", "/volunteer/sign-in"]) {
    const response = await page.goto(path);
    expect(response?.status()).toBe(200);
    await expect(page.locator("main")).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
    ).toBe(false);
  }
  expect(external).toEqual([]);
});
