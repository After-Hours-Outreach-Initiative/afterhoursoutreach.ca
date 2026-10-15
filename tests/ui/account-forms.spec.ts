import { devices, expect, test } from "@playwright/test";
import {
  createLocalAccount,
  openLocalAccountSwitcher,
  sampleAnswers,
  submitLocalApplication,
} from "../helpers/local-account";
import {
  codeOfConductConfirmation,
  codeOfConductError,
  codeOfConductRules,
} from "../../src/data/code-of-conduct";
import { totpFromSetupKey } from "../helpers/totp";
import { inPlaceAction } from "../helpers/in-place-action";
import {
  certificationOptions,
  certificationQuestion,
  applicationBirthDateError,
  latestApplicationBirthDate,
  trainingOptions,
  trainingQuestion,
} from "../../src/data/application";

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

test("application shows all required errors and saves after they are corrected", async ({
  page,
  baseURL,
}) => {
  const { email } = await createLocalAccount(page.request, baseURL!, false);
  await page.goto("/apply");
  const form = page.locator("[data-account-profile]");
  await expect(form.getByRole("heading", { level: 3 })).toHaveText([
    "Personal info",
    "Emergency contact",
    "Team interests",
    "Training and safety",
    "About volunteering",
  ]);
  const emailInput = form.locator("input").first();
  await expect(emailInput).toHaveAttribute("type", "email");
  await expect(emailInput).toHaveValue(email);
  await expect(emailInput).not.toBeEditable();
  await expect(
    form
      .getByRole("group", { name: "Personal info", exact: true })
      .getByLabel(
        "Medical conditions/allergies/anything else we should know (optional)",
        { exact: true },
      ),
  ).toBeVisible();
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
  const training = form.getByRole("group", {
    name: "Training and safety",
    exact: true,
  });
  await expect(training).toBeVisible();
  await expect(training.locator('[name="experience"]')).toBeHidden();
  await expect(training.locator("[data-medic-certifications]")).toBeHidden();
  await expect(training.locator("[required]")).toHaveCount(0);
  await expect(
    form
      .getByRole("group", { name: "Team interests", exact: true })
      .locator(".volunteer-field .volunteer-required"),
  ).toHaveText("*");
  const outreach = form.getByRole("checkbox", {
    name: "Outreach",
    exact: true,
  });
  await expect(outreach).toBeChecked();
  await expect(outreach).toBeDisabled();
  for (const field of [
    "emergencyName",
    "emergencyPhone",
    "emergencyRelationship",
  ])
    await expect(
      emergencyContact.locator(`input[name="${field}"]`),
    ).toHaveAttribute("required", "");
  await expect(
    form.getByRole("group", {
      name: "How did you find out about us?",
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
      const teams = element.querySelector(".volunteer-team-options")!;
      const rules = element.querySelector(".volunteer-code-of-conduct")!;
      const submit = element.querySelector("[data-application-submit]")!;
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
    page.getByRole("button", { name: "Review application" }),
  ).toBeEnabled();
  await expect(form.locator("[data-error]:visible")).toHaveCount(0);
  await page.getByRole("button", { name: "Review application" }).click();
  const required = form.locator(
    "input[required]:enabled, textarea[required]:enabled",
  );
  const count = await required.count();
  expect(count).toBeGreaterThan(1);
  await expect(form.locator("[data-error]:visible")).toHaveCount(count);
  for (const input of await required.all()) {
    expect(
      await input.evaluate((element) => element.matches(":user-invalid")),
    ).toBe(true);
    const id = await input.getAttribute("id");
    const label =
      (await input.getAttribute("name")) === "heardAboutUsSources"
        ? form.locator("[data-referral-sources] > legend")
        : form.locator(`label[for="${id}"]`);
    await expect(label.locator(".volunteer-required")).toHaveText("*");
  }
  await expect(
    page.getByRole("textbox", { name: "First name", exact: true }),
  ).toBeFocused();
  await expect(form.locator("[data-error=pronouns]")).toBeHidden();
  await expect(form.locator("[data-error=medicalConditions]")).toBeHidden();
  await page
    .getByRole("textbox", { name: "First name", exact: true })
    .fill("   ");
  await expect(form.locator("[data-error=firstName]")).toHaveText(
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
    if (field === "heardAboutUsSources") {
      for (const source of sampleAnswers.heardAboutUsSources)
        await form.locator(`[name="${field}"][value="${source}"]`).check();
    } else if (
      ![
        "heardAboutUs",
        "heardAboutUsOther",
        "teams",
        "certification",
        "certifications",
        "certificationExpiry",
        "experience",
        "training",
        "otherTraining",
      ].includes(field)
    )
      await form.locator(`[name="${field}"]`).fill(String(value));
  }
  await page.setViewportSize({ width: 375, height: 812 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
  ).toBe(false);
  await page.getByRole("button", { name: "Review application" }).click();
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
  await page.getByRole("button", { name: "Submit application" }).click();
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
  await page.getByRole("button", { name: "Submit application" }).click();
  await expect(page).toHaveURL(/\/volunteer\/account$/);
  expect(requests).toHaveLength(1);
  await expect(
    page.getByRole("textbox", { name: "First name", exact: true }),
  ).toHaveValue(sampleAnswers.firstName);
  await expect(
    page.getByRole("region", { name: "Code of Conduct", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.locator(
      '[name="heardAboutUsSources"], [name="heardAboutUsOther"], [name="motivation"]',
    ),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Save profile" }),
  ).toBeDisabled();
  // Editing reuses validation and identifies successful saves semantically.
  await page
    .getByRole("textbox", { name: "First name", exact: true })
    .fill("Updated volunteer");
  await page.getByRole("button", { name: "Save profile" }).click();
  const saved = page.locator("[data-account-profile] [data-form-message]");
  await expect(saved).toHaveAttribute("data-message-kind", "success");
  await expect(
    page.getByRole("button", { name: "Save profile" }),
  ).toBeDisabled();
  await page.reload();
  await expect(
    page.getByRole("textbox", { name: "First name", exact: true }),
  ).toHaveValue("Updated volunteer");
});

test("mobile birth-date picker stays blank without a past calendar maximum", async ({
  browser,
  baseURL,
}) => {
  const context = await browser.newContext({
    ...devices["Pixel 7"],
    baseURL,
  });
  try {
    await createLocalAccount(context.request, baseURL!, false);
    const page = await context.newPage();
    await page.goto("/apply");
    const form = page.locator("[data-account-profile]");
    const birthDate = form.locator('[name="birthDate"]');
    await expect(birthDate).toHaveAttribute("type", "date");
    await expect(birthDate).toHaveAttribute("min", "1900-01-01");
    await expect(birthDate).not.toHaveAttribute("max");
    await birthDate.focus();
    await expect(birthDate).toHaveValue("");
    expect(
      await birthDate.evaluate(
        (input: HTMLInputElement) => input.validity.valueMissing,
      ),
    ).toBe(true);

    // Native pickers can report a selection through change rather than input.
    await birthDate.evaluate((input: HTMLInputElement) => {
      input.value = "2999-01-01";
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await expect(birthDate).toHaveJSProperty(
      "validationMessage",
      applicationBirthDateError,
    );
    await form.evaluate((element: HTMLFormElement) => element.reset());
    await expect(birthDate).toHaveValue("");
    expect(
      await birthDate.evaluate(
        (input: HTMLInputElement) => input.validity.customError,
      ),
    ).toBe(false);
    await expect(birthDate).not.toHaveAttribute("max");
  } finally {
    await context.close();
  }
});

test("application and profile edits block underage birth dates at the birthday boundary", async ({
  page,
  baseURL,
}) => {
  await createLocalAccount(page.request, baseURL!, false);
  await page.goto("/apply");
  const form = page.locator("[data-account-profile]");
  const birthDate = form.locator('[name="birthDate"]');
  const cutoff = latestApplicationBirthDate();
  await expect(birthDate).not.toHaveAttribute("max");
  const today = new Date();
  expect(cutoff.slice(0, 4)).toBe(String(today.getUTCFullYear() - 19));
  expect(cutoff.slice(5)).toBe(
    today.toISOString().slice(5, 10) === "02-29"
      ? "02-28"
      : today.toISOString().slice(5, 10),
  );
  for (const [field, value] of Object.entries(sampleAnswers)) {
    if (field === "heardAboutUsSources") {
      for (const source of sampleAnswers.heardAboutUsSources)
        await form.locator(`[name="${field}"][value="${source}"]`).check();
    } else if (
      ![
        "heardAboutUs",
        "heardAboutUsOther",
        "teams",
        "certification",
        "certifications",
        "certificationExpiry",
        "experience",
        "training",
        "otherTraining",
      ].includes(field)
    )
      await form.locator(`[name="${field}"]`).fill(String(value));
  }
  await expect(form.getByLabel("Outreach", { exact: true })).toBeChecked();
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
    await form.getByRole("button", { name: "Review application" }).click();
    await expect(birthDate).toBeFocused();
    await expect(form.locator("[data-error=birthDate]")).toBeVisible();
    await expect(form.locator("[data-error=birthDate]")).toHaveText(
      applicationBirthDateError,
    );
    expect(requests).toEqual([]);
    await expect(page).toHaveURL(/\/apply$/);
  }
  await birthDate.fill(cutoff);
  await expect(form.locator("[data-error=birthDate]")).toBeHidden();
  await submitLocalApplication(page);
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

test("the application requires JavaScript and retains birth-date constraints", async ({
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
    await page.goto("/apply");
    const form = page.locator("[data-account-profile]");
    const birthDate = form.locator('[name="birthDate"]');
    const cutoff = (await birthDate.getAttribute("max"))!;
    expect(cutoff).toBe(latestApplicationBirthDate());
    await expect(birthDate).toHaveAttribute("min", "1900-01-01");
    await expect(birthDate).toHaveValue("");
    const younger = new Date(`${cutoff}T00:00:00Z`);
    younger.setUTCDate(younger.getUTCDate() + 1);
    await birthDate.fill(younger.toISOString().slice(0, 10));
    await expect(
      form.getByRole("button", { name: "Review application" }),
    ).toBeDisabled();
    expect(
      await birthDate.evaluate(
        (input: HTMLInputElement) => input.validity.valid,
      ),
    ).toBe(false);
    await expect(page).toHaveURL(/\/apply$/);
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

test("all teams can select multiple relevant training answers and add Other details", async ({
  page,
  baseURL,
}) => {
  await createLocalAccount(page.request, baseURL!, false);
  await page.goto("/apply");
  const form = page.locator("[data-account-profile]");
  const training = form.getByRole("group", {
    name: trainingQuestion,
    exact: true,
  });
  const details = training.locator("[data-other-relevant-training]");
  const otherText = details.locator('[name="otherTraining"]');
  const other = training.getByRole("checkbox", { name: "Other", exact: true });
  const naloxone = training.getByRole("checkbox", {
    name: "Naloxone administration training",
    exact: true,
  });
  const crisis = training.getByRole("checkbox", {
    name: "Crisis intervention and de-escalation training (specify under Other)",
    exact: true,
  });
  const medic = form.getByLabel("Medic", { exact: true });
  const support = form.getByLabel("Non-patrol support", { exact: true });
  const requests: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/v1/account/profile")
      requests.push(request.url());
  });
  await expect(training).toBeVisible();
  await expect(details).toBeHidden();
  await expect(otherText).not.toHaveAttribute("required");
  await expect(otherText).toHaveAttribute("readonly", "");
  await expect(
    training.locator(".volunteer-training-options > label"),
  ).toHaveText(trainingOptions.map((option) => option.label));
  for (const width of [1280, 375, 320]) {
    await page.setViewportSize({ width, height: 812 });
    expect(
      await training
        .locator(".volunteer-training-options")
        .evaluate(
          (element) =>
            getComputedStyle(element).gridTemplateColumns.split(" ").length,
        ),
    ).toBe(1);
    const alignment = await training
      .locator(".volunteer-check")
      .evaluateAll((labels) =>
        labels.map((label) => {
          const input = label.querySelector("input")!.getBoundingClientRect();
          const text = label.querySelector("span")!;
          const bounds = text.getBoundingClientRect();
          const lineHeight = parseFloat(getComputedStyle(text).lineHeight);
          return {
            lines: Math.round(bounds.height / lineHeight),
            offset:
              input.top + input.height / 2 - (bounds.top + lineHeight / 2),
          };
        }),
      );
    for (const option of alignment)
      expect(Math.abs(option.offset)).toBeLessThanOrEqual(1);
    if (width <= 375)
      expect(alignment.some((option) => option.lines > 1)).toBe(true);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
    ).toBe(false);
  }
  for (const [field, value] of Object.entries(sampleAnswers)) {
    if (field === "heardAboutUsSources") {
      for (const source of sampleAnswers.heardAboutUsSources)
        await form.locator(`[name="${field}"][value="${source}"]`).check();
    } else if (
      ![
        "heardAboutUs",
        "heardAboutUsOther",
        "teams",
        "certification",
        "certifications",
        "certificationExpiry",
        "experience",
        "training",
        "otherTraining",
      ].includes(field)
    )
      await form.locator(`[name="${field}"]`).fill(String(value));
  }
  await naloxone.check();
  await crisis.check();
  await other.check();
  await expect(training.locator(":checked")).toHaveCount(3);
  await expect(otherText).toBeEditable();
  await expect(otherText).toHaveAttribute("required", "");
  await expect(
    training.locator(
      'label:has([value="other"]) + [data-other-relevant-training]',
    ),
  ).toBeVisible();
  await expect(details.locator("label")).toHaveClass("sr-only");
  await expect(details.locator(".volunteer-help")).toHaveCount(0);
  for (const blank of ["", " \t\n\u00a0 "]) {
    await otherText.fill(blank);
    await form.getByRole("button", { name: "Review application" }).click();
    await expect(otherText).toBeFocused();
    await expect(details.locator("[data-error=otherTraining]")).toBeVisible();
    expect(requests).toHaveLength(0);
  }
  await otherText.fill("Crisis intervention course");
  await medic.check();
  await expect(training).toBeVisible();
  await expect(otherText).toBeEditable();
  await expect(training.locator(":checked")).toHaveCount(3);
  await support.check();
  await medic.uncheck();
  await expect(training).toBeVisible();
  await submitLocalApplication(page);
  await expect(page).toHaveURL(/\/volunteer\/account$/);
  await page.reload();
  await expect(medic).not.toBeChecked();
  await expect(support).toBeChecked();
  await expect(naloxone).toBeChecked();
  await expect(crisis).toBeChecked();
  await expect(other).toBeChecked();
  await expect(otherText).toHaveValue("Crisis intervention course");
  const save = form.getByRole("button", { name: "Save profile" });
  await expect(save).toBeDisabled();
  await other.uncheck();
  await expect(details).toBeHidden();
  await expect(otherText).not.toHaveAttribute("required");
  await form.evaluate((element: HTMLFormElement) => element.reset());
  await expect(other).toBeChecked();
  await expect(otherText).toBeEditable();
  await expect(save).toBeDisabled();
  await other.uncheck();
  await save.click();
  await expect(form.locator("[data-form-message]")).toHaveText(
    "Profile saved.",
  );
  await page.reload();
  await expect(other).not.toBeChecked();
  await expect(details).toBeHidden();
  await other.check();
  await expect(otherText).toHaveValue("Crisis intervention course");
  const savedRequests = requests.length;
  await otherText.fill(" ");
  await save.click();
  await expect(otherText).toBeFocused();
  await expect(details.locator("[data-error=otherTraining]")).toBeVisible();
  expect(requests).toHaveLength(savedRequests);
  await other.uncheck();
  await naloxone.uncheck();
  await crisis.uncheck();
  await save.click();
  await expect(form.locator("[data-form-message]")).toHaveText(
    "Profile saved.",
  );
  await page.reload();
  await expect(training).toBeVisible();
  await expect(training.locator(":checked")).toHaveCount(0);
  await expect(details).toBeHidden();
});

test("Medic selects one highest certification, expiry and conditional Other details", async ({
  page,
  baseURL,
}) => {
  await createLocalAccount(page.request, baseURL!, false);
  await page.goto("/apply");
  const profileRequests: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/v1/account/profile")
      profileRequests.push(request.url());
  });
  const form = page.locator("[data-account-profile]");
  const training = form.getByRole("group", {
    name: "Training and safety",
    exact: true,
  });
  const certifications = form.locator("[data-medic-certifications]");
  const medic = form.getByLabel("Medic", { exact: true });
  const firstAid = certifications.getByRole("radio", {
    name: "Advanced First Aid (formerly OFA Level 3)",
    exact: true,
  });
  const nurse = certifications.getByRole("radio", {
    name: "Nurse (LPN, RN)",
    exact: true,
  });
  const practitioner = certifications.getByRole("radio", {
    name: "Respiratory Therapist (RT) / Nurse Practitioner (NP) / Physician",
    exact: true,
  });
  const paramedic = certifications.getByRole("radio", {
    name: "Paramedic (PCP, ACP, CCP)",
    exact: true,
  });
  const experience = form.locator('[name="experience"]');
  const other = certifications.getByRole("radio", {
    name: "Other",
    exact: true,
  });
  const expiry = form.locator('[name="certificationExpiry"]');
  await expect(training).toBeVisible();
  await expect(experience).toBeHidden();
  await expect(experience).not.toHaveAttribute("required");
  await expect(experience).toHaveAttribute("readonly", "");
  await expect(certifications).toBeHidden();
  await expect(expiry).toBeHidden();
  await expect(expiry).not.toHaveAttribute("required");
  for (const [field, value] of Object.entries(sampleAnswers)) {
    if (field === "heardAboutUsSources") {
      for (const source of sampleAnswers.heardAboutUsSources)
        await form.locator(`[name="${field}"][value="${source}"]`).check();
    } else if (
      ![
        "heardAboutUs",
        "heardAboutUsOther",
        "teams",
        "certification",
        "certifications",
        "certificationExpiry",
        "experience",
        "training",
        "otherTraining",
      ].includes(field)
    )
      await form.locator(`[name="${field}"]`).fill(String(value));
  }
  await expect(form.getByLabel("Outreach", { exact: true })).toBeChecked();
  await medic.check();
  await expect(certifications).toBeVisible();
  await expect(experience).toBeHidden();
  await expect(expiry).toBeVisible();
  await expect(expiry).toHaveAttribute("type", "date");
  await expect(expiry).toHaveAttribute("required", "");
  await expect(expiry).toHaveAccessibleName("Certification expiry date");
  await expect(
    form.locator("[data-certification-expiry] .volunteer-required"),
  ).toHaveText("*");
  await expect(
    form.locator("[data-certification-expiry] .volunteer-help"),
  ).toHaveCount(0);
  await expect(certifications).toHaveAccessibleName(certificationQuestion);
  await expect(
    certifications.getByText("Select one.", { exact: true }),
  ).toHaveCount(0);
  await expect(certifications).toHaveAttribute(
    "aria-describedby",
    "error-certifications",
  );
  await expect(
    certifications.locator(".volunteer-certification-options > label"),
  ).toHaveText(certificationOptions.map((option) => option.label));
  await expect(
    certifications.getByRole("radio", {
      name: "First Responder (FR)",
      exact: true,
    }),
  ).toHaveCount(0);
  await expect(form.getByRole("heading", { level: 3 })).toHaveText([
    "Personal info",
    "Emergency contact",
    "Team interests",
    "Training and safety",
    "About volunteering",
  ]);
  await form.getByRole("button", { name: "Review application" }).click();
  await expect(firstAid).toBeFocused();
  await expect(
    certifications.locator("[data-error=certifications]"),
  ).toBeVisible();
  await firstAid.press("Space");
  await expect(firstAid).toBeChecked();
  await form.getByRole("button", { name: "Review application" }).click();
  await expect(expiry).toBeFocused();
  await expect(form.locator("[data-error=certificationExpiry]")).toBeVisible();
  expect(profileRequests).toHaveLength(0);
  await expiry.fill("2030-10-14");
  await expect(form.locator("[data-error=certificationExpiry]")).toBeHidden();
  await nurse.check();
  await expect(firstAid).not.toBeChecked();
  await expect(nurse).toBeChecked();
  await paramedic.check();
  await expect(nurse).not.toBeChecked();
  await expect(paramedic).toBeChecked();
  await practitioner.check();
  await expect(paramedic).not.toBeChecked();
  await expect(practitioner).toBeChecked();
  await expect(certifications.locator(":checked")).toHaveCount(1);
  await expect(
    certifications.locator("[data-error=certifications]"),
  ).toBeHidden();
  await expect(experience).toBeHidden();
  await other.check();
  await expect(practitioner).not.toBeChecked();
  await expect(experience).toBeVisible();
  await expect(form.locator('[name="experience"]')).toHaveCount(1);
  await expect(
    certifications.locator(
      'label:has([value="other"]) + [data-other-training]',
    ),
  ).toBeVisible();
  await expect(experience).toBeEditable();
  await expect(experience).toHaveAttribute("required", "");
  await expect(form.locator("[data-other-training] > label")).toHaveClass(
    "sr-only",
  );
  await expect(
    form.locator("[data-other-training] .volunteer-help"),
  ).toHaveCount(0);
  await expect(experience).toHaveAttribute(
    "aria-describedby",
    "error-experience",
  );
  for (const blank of ["", " \t\n\u00a0 "]) {
    await experience.fill(blank);
    await form.getByRole("button", { name: "Review application" }).click();
    await expect(experience).toBeFocused();
    await expect(form.locator("[data-error=experience]")).toBeVisible();
    expect(profileRequests).toHaveLength(0);
  }
  await expect(
    certifications.locator("[data-error=certifications]"),
  ).toBeHidden();
  await experience.fill("Naloxone training");
  await expect(experience).toHaveJSProperty("validationMessage", "");
  await firstAid.check();
  await expect(experience).toBeHidden();
  await expect(experience).not.toHaveAttribute("required");
  await other.check();
  await expect(experience).toHaveValue("Naloxone training");
  await medic.uncheck();
  await expect(training).toBeVisible();
  await expect(certifications).toBeHidden();
  await expect(certifications.locator("[required]")).toHaveCount(0);
  await expect(expiry).toBeHidden();
  await expect(expiry).not.toHaveAttribute("required");
  await expect(experience).toBeHidden();
  await expect(experience).not.toHaveAttribute("required");
  await medic.check();
  await expect(other).toBeChecked();
  await expect(expiry).toHaveValue("2030-10-14");
  await expect(expiry).toHaveAttribute("required", "");
  await expect(experience).toHaveValue("Naloxone training");
  await submitLocalApplication(page);
  await expect(page).toHaveURL(/\/volunteer\/account$/);
  await page.reload();
  await expect(medic).toBeChecked();
  await expect(certifications).toBeVisible();
  await expect(other).toBeChecked();
  await expect(certifications.locator(":checked")).toHaveCount(1);
  await expect(expiry).toHaveValue("2030-10-14");
  await expect(experience).toBeEditable();
  await expect(experience).toHaveValue("Naloxone training");
  const save = form.getByRole("button", { name: "Save profile" });
  await expect(save).toBeDisabled();
  const submittedRequests = profileRequests.length;
  await expiry.fill("");
  await save.click();
  await expect(expiry).toBeFocused();
  await expect(form.locator("[data-error=certificationExpiry]")).toBeVisible();
  expect(profileRequests).toHaveLength(submittedRequests);
  await medic.uncheck();
  await expect(expiry).toBeHidden();
  await expect(expiry).not.toHaveAttribute("required");
  expect(
    await form.evaluate((element: HTMLFormElement) => element.checkValidity()),
  ).toBe(true);
  await medic.check();
  await expect(expiry).toHaveAttribute("required", "");
  await form.evaluate((element: HTMLFormElement) => element.reset());
  await expect(expiry).toHaveValue("2030-10-14");
  await expect(expiry).toHaveAttribute("required", "");
  await expect(save).toBeDisabled();
  await nurse.check();
  await expect(save).toBeEnabled();
  await expect(experience).toBeHidden();
  await other.check();
  await expect(save).toBeDisabled();

  // Deselecting Medic retains saved selections, even while the question is hidden.
  await medic.uncheck();
  await save.click();
  await expect(form.locator("[data-form-message]")).toHaveText(
    "Profile saved.",
  );
  await page.reload();
  await expect(certifications).toBeHidden();
  await expect(expiry).toBeHidden();
  await medic.check();
  await expect(other).toBeChecked();
  await expect(experience).toHaveValue("Naloxone training");

  // Blank Other details block edits, but not saving a different certification.
  const savedRequests = profileRequests.length;
  for (const blank of ["", " \t\n\u00a0 "]) {
    await experience.fill(blank);
    await save.click();
    await expect(experience).toBeFocused();
    await expect(form.locator("[data-error=experience]")).toBeVisible();
    expect(profileRequests).toHaveLength(savedRequests);
  }
  await firstAid.check();
  await expect(experience).toBeHidden();
  expect(
    await experience.evaluate(
      (field: HTMLTextAreaElement) => field.validity.customError,
    ),
  ).toBe(false);
  await save.click();
  await expect(form.locator("[data-form-message]")).toHaveText(
    "Profile saved.",
  );
  await page.reload();
  await expect(firstAid).toBeChecked();
  await expect(other).not.toBeChecked();
  await expect(experience).toBeHidden();
  await expect(expiry).toHaveValue("2030-10-14");
  await other.check();
  await expect(experience).toBeEditable();
  await expect(experience).toHaveValue("");
  await experience.fill(" \t\n\u00a0 ");
  expect(
    await experience.evaluate(
      (field: HTMLTextAreaElement) => field.validity.customError,
    ),
  ).toBe(true);
  await form.evaluate((element: HTMLFormElement) => element.reset());
  await expect(firstAid).toBeChecked();
  await expect(experience).toBeHidden();
  expect(
    await experience.evaluate(
      (field: HTMLTextAreaElement) => field.validity.customError,
    ),
  ).toBe(false);
  await expect(save).toBeDisabled();
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
  const name = form.locator('[name="firstName"]');
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
    ["firstName", "Updated volunteer"],
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
  await name.fill(` ${sampleAnswers.firstName} `);
  await expect(save).toBeDisabled();
  await name.fill("Reset this draft");
  await expect(save).toBeEnabled();
  await form.evaluate((element: HTMLFormElement) => element.reset());
  await expect(save).toBeDisabled();

  await name.fill("");
  await save.click();
  await expect(form.locator("[data-error=firstName]")).toHaveText(
    "This field is required.",
  );
  await expect(form.locator("[data-error=firstName]")).toBeVisible();
  expect(requests).toEqual([]);
  await name.fill(sampleAnswers.firstName);
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
  await name.fill(sampleAnswers.firstName);
  await expect(save).toBeEnabled();
  await name.fill("Updated volunteer");
  await expect(save).toBeDisabled();
  await page.reload();
  await expect(name).toHaveValue("Updated volunteer");
  await expect(save).toBeDisabled();
});

test("Outreach stays selected while optional teams support cards, keyboard input and reset", async ({
  page,
  baseURL,
}) => {
  await createLocalAccount(page.request, baseURL!);
  await page.goto("/volunteer/account");
  const form = page.locator("[data-account-profile]");
  const outreach = form.getByLabel("Outreach", { exact: true });
  const medic = form.getByLabel("Medic", { exact: true });
  const support = form.getByLabel("Non-patrol support", { exact: true });
  const save = form.getByRole("button", { name: "Save profile" });
  const cards = form.locator(".volunteer-team-option");
  const training = form.locator("[data-medic-certifications]");
  await expect(training).toBeHidden();
  await expect(cards).toHaveCount(3);
  await expect(outreach).toHaveAccessibleDescription(
    /Hand out supplies and connect with the DTES community/,
  );
  await expect(medic).toHaveAccessibleDescription(
    /Provide first aid and assist in emergency overdose response/,
  );
  const medicRequirement = cards.nth(1).locator(".volunteer-team-requirement");
  await expect(medicRequirement).toHaveText(
    "Minimum requirement: Valid OFA Level 3 or Advanced First Aid certification.",
  );
  await expect(medicRequirement).toHaveCSS("color", "rgb(248, 113, 113)");
  await expect(medicRequirement).toHaveCSS("margin-top", "12px");
  await expect(medic).toHaveAccessibleDescription(
    /Minimum requirement: Valid OFA Level 3/,
  );
  await expect(
    form.getByLabel("Non-patrol support", { exact: true }),
  ).toHaveAccessibleDescription(/Assist with inventory, logistics/);
  const requests: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/v1/account/profile")
      requests.push(request.url());
  });
  await expect(outreach).toBeChecked();
  await expect(outreach).toBeDisabled();
  await expect(cards.first()).toHaveCSS("opacity", "1");
  await expect(cards.first()).toHaveCSS("cursor", "default");
  // Attempt a pointer click despite Playwright's disabled-control guard.
  await cards
    .getByText("Hand out supplies and connect with the DTES community.", {
      exact: true,
    })
    .click({ force: true });
  await expect(outreach).toBeChecked();
  await expect(save).toBeDisabled();
  expect(
    await form.evaluate((element: HTMLFormElement) =>
      new FormData(element).getAll("teams"),
    ),
  ).toEqual(["outreach"]);
  expect(requests).toEqual([]);
  await medicRequirement.click();
  await expect(medic).toBeChecked();
  await expect(cards.nth(1)).toHaveCSS("background-color", "rgb(22, 33, 74)");
  await expect(training).toBeVisible();
  await expect(form.locator('[name="teams"][required]')).toHaveCount(0);
  await medic.press("Tab");
  await expect(support).toBeFocused();
  await expect(cards.nth(2)).toHaveCSS("outline-style", "solid");
  await support.press("Space");
  await expect(support).toBeChecked();
  await expect(medic).toBeChecked();
  await medic.focus();
  await medic.press("Space");
  await expect(medic).not.toBeChecked();
  await expect(training).toBeHidden();
  await support.uncheck();
  await expect(save).toBeDisabled();
  await medic.check();
  await support.check();
  const other = training.getByRole("radio", {
    name: "Other",
    exact: true,
    includeHidden: true,
  });
  await other.check();
  await expect(form.locator('[name="experience"]')).toBeVisible();
  await form.evaluate((element: HTMLFormElement) => element.reset());
  await expect(outreach).toBeChecked();
  await expect(outreach).toBeDisabled();
  await expect(medic).not.toBeChecked();
  await expect(support).not.toBeChecked();
  await expect(training).toBeHidden();
  await expect(training.locator("[required]")).toHaveCount(0);
  await expect(other).not.toBeChecked();
  await expect(form.locator('[name="experience"]')).toBeHidden();
  await expect(form.locator('[name="experience"]')).not.toHaveAttribute(
    "required",
  );
  await expect(form.locator('[name="teams"][required]')).toHaveCount(0);
  await expect(save).toBeDisabled();
  expect(requests).toEqual([]);
  await support.check();
  await save.click();
  await expect(form.locator("[data-form-message]")).toHaveText(
    "Profile saved.",
  );
  await page.reload();
  await expect(outreach).toBeChecked();
  await expect(outreach).toBeDisabled();
  await expect(support).toBeChecked();
  await expect(training).toBeHidden();
  expect(requests).toHaveLength(1);
});

test("email changes verify the new address in place and preserve unsaved profile answers", async ({
  page,
  baseURL,
}) => {
  const { id, email } = await createLocalAccount(page.request, baseURL!);
  await page.goto("/volunteer/account");
  const name = page.getByRole("textbox", {
    name: "First name",
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
  await expect(name).toHaveValue(sampleAnswers.firstName);
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
  const name = form.locator('[name="firstName"]');
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
  await name.fill(sampleAnswers.firstName);
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
  const name = form.locator('[name="firstName"]');
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
    name: "First name",
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
