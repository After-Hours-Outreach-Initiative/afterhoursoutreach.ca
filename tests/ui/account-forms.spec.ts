import { expect, test } from "@playwright/test";
import { createLocalAccount, sampleAnswers } from "../helpers/local-account";
import {
  codeOfConductConfirmation,
  codeOfConductError,
  codeOfConductRules,
} from "../../src/data/code-of-conduct";
import { totpFromSetupKey } from "../helpers/totp";
import { inPlaceAction } from "../helpers/in-place-action";

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

test("email sign-in validates, loads, switches to code, and resets", async ({
  page,
}) => {
  let finishSending!: () => void;
  const sending = new Promise<void>((resolve) => {
    finishSending = resolve;
  });
  const emails: string[] = [];
  await page.route(
    "**/api/auth/email-otp/send-verification-otp**",
    async (route) => {
      emails.push(route.request().postDataJSON().email);
      await sending;
      await route.fulfill({ json: { success: true } });
    },
  );
  const proofs: object[] = [];
  await page.route("**/api/auth/sign-in/email-otp**", async (route) => {
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
  await expect(emailForm).toHaveAttribute("novalidate", "");
  await expect(emailForm.locator("label")).toHaveText("Email");
  await continueButton.click();
  await expect(emailForm.locator("[data-error=email]")).toHaveText(
    "This field is required.",
  );
  await expect(emailInput).toHaveAttribute("aria-invalid", "true");
  await emailInput.fill("not-an-email");
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
    "/api/auth/email-otp/send-verification-otp",
    {
      headers: { origin: baseURL! },
      data: { email, type: "sign-in" },
    },
  );
  expect(sent.status(), await sent.text()).toBe(200);
  await page.goto("/volunteer/sign-in");
  await expect(page.locator("[data-email-request]")).toHaveAttribute(
    "novalidate",
    "",
  );
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
  await page.route("**/api/auth/email-otp/send-verification-otp**", (route) =>
    route.fulfill({ status: 429, json: {} }),
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
  await createLocalAccount(page.request, baseURL!, false);
  await page.goto("/volunteer/register");
  const form = page.locator("[data-account-profile]");
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
  await expect(toggle).toHaveAccessibleName("Read all 14 rules");
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
  await expect(form).toHaveAttribute("novalidate", "");
  const requests: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/account/profile")
      requests.push(request.url());
  });
  await page.getByRole("button", { name: "Complete registration" }).click();
  const required = form.locator("input[required], textarea[required]");
  const count = await required.count();
  expect(count).toBeGreaterThan(1);
  await expect(form.locator("[data-error]:visible")).toHaveCount(count + 1);
  for (const input of await required.all()) {
    await expect(input).toHaveAttribute("aria-invalid", "true");
    const id = await input.getAttribute("id");
    await expect(
      form.locator(`label[for="${id}"] .volunteer-required`),
    ).toHaveText("*");
  }
  await expect(form.locator("[data-error=teams]")).toHaveText(
    "Choose at least one team.",
  );
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
  await page.getByLabel(/^Date of birth/).fill("2999-01-01");
  await expect(form.locator("[data-error=birthDate]")).toContainText("today");
  expect(requests).toEqual([]);
  for (const [field, value] of Object.entries(sampleAnswers)) {
    if (field !== "teams")
      await form.locator(`[name="${field}"]`).fill(String(value));
  }
  await page.getByRole("button", { name: "Complete registration" }).click();
  await expect(form.getByLabel("Outreach", { exact: true })).toBeFocused();
  expect(requests).toEqual([]);
  await form.getByLabel("Outreach", { exact: true }).check();
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
  await expect(confirmation).toBeFocused();
  expect(requests).toEqual([]);
  await confirmation.press("Space");
  await expect(confirmation).toBeChecked();
  await expect(confirmation).not.toHaveAttribute("aria-invalid");
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
  // Editing reuses validation and identifies successful saves semantically.
  await page
    .getByRole("textbox", { name: "Full or preferred name", exact: true })
    .fill("Updated volunteer");
  await page.getByRole("button", { name: "Save profile" }).click();
  const saved = page.locator("[data-account-profile] [data-form-message]");
  await expect(saved).toHaveAttribute("data-message-kind", "success");
  await page.reload();
  await expect(
    page.getByRole("textbox", { name: "Full or preferred name", exact: true }),
  ).toHaveValue("Updated volunteer");
});

test("authenticator setup and sign-in show inline required and code errors", async ({
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
  await page.getByRole("button", { name: "Verify and enable" }).click();
  await expect(setup.locator("[data-error=factor-setup-code]")).toHaveText(
    "This field is required.",
  );
  const code = setup.locator('input[name="code"]');
  await code.fill("123");
  await expect(setup.locator("[data-error=factor-setup-code]")).toHaveText(
    "Enter a six-digit code.",
  );
  const key = (await page.locator("[data-factor-key]").textContent())!;
  await code.fill(totpFromSetupKey(key));
  await inPlaceAction(page, {
    endpoint: "/api/auth/two-factor/verify-totp",
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
  await expect(challenge).toHaveAttribute("novalidate", "");
  await expect(challenge).toBeVisible();
  await expect(page.locator("[data-email-request]")).toBeHidden();
  await page.getByRole("button", { name: "Verify code", exact: true }).click();
  await expect(challenge.locator("[data-error=second-factor-code]")).toHaveText(
    "This field is required.",
  );
  await expect(challenge.locator('input[name="code"]')).toHaveAttribute(
    "aria-invalid",
    "true",
  );
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
