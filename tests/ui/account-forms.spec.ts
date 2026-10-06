import { expect, test } from "@playwright/test";
import { createLocalAccount, sampleAnswers } from "../helpers/local-account";
import { totpFromSetupKey } from "../helpers/totp";

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

for (const path of ["/volunteer", "/volunteer/sign-in"]) {
  test(`email sign-in validates, loads, switches to code, and resets on ${path}`, async ({
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
    await page.goto(path);
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
    await expect(
      page.getByText("Email sent. You can request another after one minute."),
    ).toHaveCount(0);
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
    await expect(codeForm.locator("[data-form-message]")).toHaveCSS(
      "color",
      "rgb(248, 113, 113)",
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
}

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
  await expect(error).toHaveCSS("color", "rgb(248, 113, 113)");
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
    await expect(input).toHaveCSS("border-color", "rgb(248, 113, 113)");
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
  await form.getByLabel("Outreach", { exact: true }).check();
  await expect(form.locator("[data-error]:visible")).toHaveCount(0);
  await expect(form.locator("[data-form-message]")).toBeHidden();
  await page.getByRole("button", { name: "Complete registration" }).click();
  await expect(page).toHaveURL(/\/volunteer\/account$/);
  expect(requests).toHaveLength(1);
  await expect(
    page.getByRole("textbox", { name: "Full or preferred name", exact: true }),
  ).toHaveValue(sampleAnswers.name);
  // Editing the account uses the same validation, but successful saves aren't red errors.
  await page
    .getByRole("textbox", { name: "Full or preferred name", exact: true })
    .fill("Updated volunteer");
  await page.getByRole("button", { name: "Save profile" }).click();
  const saved = page.locator("[data-account-profile] [data-form-message]");
  await expect(saved).toHaveAttribute("data-message-kind", "success");
  await expect(saved).not.toHaveCSS("color", "rgb(248, 113, 113)");
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
  await page.getByRole("button", { name: "Set up an authenticator" }).click();
  const setup = page.locator("[data-confirm-factor]");
  await expect(setup).toBeVisible();
  await page.getByRole("button", { name: "Verify and enable" }).click();
  await expect(setup.locator("[data-error=factor-setup-code]")).toHaveText(
    "This field is required.",
  );
  await expect(setup.locator("[data-error=factor-setup-code]")).toHaveCSS(
    "color",
    "rgb(248, 113, 113)",
  );
  const code = setup.locator('input[name="code"]');
  await code.fill("123");
  await expect(setup.locator("[data-error=factor-setup-code]")).toHaveText(
    "Enter a six-digit code.",
  );
  const key = (await page.locator("[data-factor-key]").textContent())!;
  await code.fill(totpFromSetupKey(key));
  await page.getByRole("button", { name: "Verify and enable" }).click();
  await expect(
    page.getByText("Your authenticator is enabled.", { exact: false }),
  ).toBeVisible();
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

test("public and private headers keep the same font and geometry, and privacy is black", async ({
  page,
  baseURL,
}) => {
  for (const width of [1280, 375]) {
    await page.setViewportSize({ width, height: 812 });
    let reference: unknown;
    for (const path of [
      "/",
      "/volunteer",
      "/privacy",
      "/about",
      "/volunteer/sign-in",
    ]) {
      const external: string[] = [];
      const record = (request: { url(): string }) => {
        if (new URL(request.url()).origin !== new URL(baseURL!).origin)
          external.push(request.url());
      };
      page.on("request", record);
      await page.goto(path);
      await page.evaluate(() => document.fonts.ready);
      expect(
        await page.evaluate(() =>
          document.fonts.check('500 16px "Public Sans"'),
        ),
      ).toBe(true);
      const geometry = await page.locator("header").evaluate((header) =>
        [header, ...header.querySelectorAll("a, summary")].map((element) => {
          const { x, y, width, height } = element.getBoundingClientRect();
          return {
            x,
            y,
            width,
            height,
            font: getComputedStyle(element).fontFamily,
          };
        }),
      );
      reference ??= geometry;
      expect(geometry).toEqual(reference);
      if (path.startsWith("/volunteer") || path === "/privacy")
        expect(external).toEqual([]);
      page.off("request", record);
      if (path === "/privacy") {
        await expect(page.locator("main > section")).toHaveCSS(
          "background-color",
          "rgb(0, 0, 0)",
        );
        await expect(
          page.getByRole("link", { name: "Back to volunteering" }),
        ).toHaveCount(0);
      }
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth > innerWidth,
        ),
      ).toBe(false);
    }
  }
});
