import { devices, expect, test } from "@playwright/test";
import {
  createLocalAccount,
  fillApplicationField,
  localApplicationReviewButton,
  openLocalAccountSwitcher,
  reviewLocalApplication,
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
    "Wait 30 seconds before requesting another email.",
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

test("other referral help separates the character limit from its unit", async ({
  page,
  baseURL,
}) => {
  await createLocalAccount(page.request, baseURL!, false);
  await page.goto("/apply");
  const form = page.locator("[data-account-profile]");
  await form.locator('[name="heardAboutUsSources"][value="other"]').check();
  await expect(form.locator("#help-heardAboutUsOther")).toBeVisible();
  await expect(form.locator("#help-heardAboutUsOther")).toHaveText(
    "Briefly describe how you found out about us (200 characters or fewer).",
  );
});

for (const path of ["/apply", "/volunteer/account"]) {
  for (const width of [375, 1280]) {
    test(`${path} contents navigation starts in its final position before scripts load at ${width}px`, async ({
      page,
      baseURL,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      await createLocalAccount(page.request, baseURL!, path !== "/apply");
      let release!: () => void;
      const scripts = new Promise<void>((resolve) => (release = resolve));
      await page.route("**/*", async (route) => {
        if (route.request().resourceType() === "script") await scripts;
        await route.continue();
      });
      try {
        await page.goto(path, { waitUntil: "commit" });
        const contents = page.locator("[data-page-contents]");
        await expect(contents).toBeVisible();
        if (path === "/volunteer/account") {
          await expect(
            page.locator('[data-profile-answer="preferredName"] dd'),
          ).toHaveText(sampleAnswers.preferredName);
          await expect(page.locator('[name="preferredName"]')).toBeHidden();
        }
        const initial = await contents.boundingBox();
        const header = await page.locator(".site-header").boundingBox();
        if (path === "/apply" && width < 1024) {
          const intro = await page
            .locator(".volunteer-application-intro")
            .boundingBox();
          expect(initial!.y).toBe(intro!.y + intro!.height + 32);
        } else {
          expect(initial!.y).toBe(
            header!.y + header!.height + (width < 1024 ? 0 : 24),
          );
        }
        release();
        await page.waitForLoadState("load");
        // Measurement enhances anchor offsets, never the navigation's position.
        await expect(
          page.locator("[data-application-flow], [data-account-contents-flow]"),
        ).toHaveAttribute("style", /--contents-scroll-offset:/);
        expect(await contents.boundingBox()).toEqual(initial);
        if (path === "/apply" && width < 1024) {
          await page.evaluate(
            (top) => scrollTo({ top, behavior: "instant" }),
            initial!.y + initial!.height + 16,
          );
          await expect(contents).toHaveCSS("position", "sticky");
          await expect
            .poll(
              async () =>
                (await contents.locator("[data-contents-bar]").boundingBox())!
                  .y,
            )
            .toBe(0);
        } else {
          await page.evaluate(() =>
            scrollTo({ top: 500, behavior: "instant" }),
          );
          await expect
            .poll(async () => (await contents.boundingBox())!.y)
            .toBe(initial!.y);
        }
      } finally {
        release();
      }
    });
  }
}

test("contents navigation contrasts with the header and leaves room for the page heading", async ({
  page,
  baseURL,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await createLocalAccount(page.request, baseURL!, false);
  await page.goto("/apply");
  const contents = page.getByRole("navigation", {
    name: "Sections",
  });
  const menu = contents.locator("[data-contents-menu]");
  await expect(menu).toBeVisible();
  await expect(menu.locator("[data-contents-current]")).toHaveText("Sections");
  await expect(contents.locator(".volunteer-contents-sidebar")).toBeHidden();
  await page.evaluate(() => {
    const nav = document
      .querySelector("[data-application-contents]")!
      .getBoundingClientRect();
    scrollTo({ top: nav.bottom + scrollY + 16, behavior: "instant" });
  });
  await expect.poll(async () => (await contents.boundingBox())!.y).toBe(0);
  const bar = menu.locator("summary");
  const toggle = bar.locator(".volunteer-contents-section-toggle");
  await expect(page.locator(".site-header")).toHaveCSS(
    "background-color",
    "rgb(0, 0, 0)",
  );
  await expect(bar).toHaveCSS("background-color", "rgb(23, 26, 32)");
  await expect(toggle).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await expect(toggle).toHaveCSS("border-width", "0px");
  const current = bar.locator("[data-contents-current]");
  await expect(current).toHaveCSS("color", "rgb(255, 255, 255)");
  await expect(current).toHaveCSS("font-size", "16px");
  await toggle.click();
  await expect(menu).toHaveAttribute("open", "");
  await expect(bar).toHaveCSS("background-color", "rgb(23, 26, 32)");
  await expect(toggle).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await page.keyboard.press("Escape");
  await expect(menu).not.toHaveAttribute("open");

  for (const width of [320, 390, 640, 768, 1023, 1024, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate(() => scrollTo({ top: 0, behavior: "instant" }));
    await expect
      .poll(() =>
        page.locator("#application-overview").evaluate((heading) => {
          const title = heading.getBoundingClientRect();
          const nav = document
            .querySelector("[data-application-contents]")!
            .getBoundingClientRect();
          return innerWidth < 1024
            ? nav.top -
                document
                  .querySelector(".volunteer-application-intro")!
                  .getBoundingClientRect().bottom
            : nav.left - title.right;
        }),
      )
      .toBeGreaterThanOrEqual(32);
  }

  await page.setViewportSize({ width: 1280, height: 900 });
  await expect(menu).toBeHidden();
  await expect(contents.locator(".volunteer-contents-sidebar")).toBeVisible();
  await expect(contents).toHaveCSS("background-color", "rgb(0, 0, 0)");
});

test("account contents navigate profile and settings sections on desktop and mobile", async ({
  page,
  baseURL,
}) => {
  await createLocalAccount(page.request, baseURL!);
  for (const width of [1280, 375]) {
    await page.setViewportSize({ width, height: 812 });
    await page.goto("/volunteer/account");
    const contents = page.getByRole("navigation", { name: "On this page" });
    const menu = contents.locator("[data-contents-menu]");
    await expect(
      contents.getByRole("link", {
        name: "Volunteer Application",
        exact: true,
        includeHidden: true,
      }),
    ).toHaveCount(2);
    const submission = page.getByRole("region", {
      name: "Volunteer Application",
      exact: true,
    });
    await expect(
      submission.getByRole("heading", { name: "Volunteer Application" }),
    ).toBeVisible();
    const submitted = submission.locator("#submitted-application-heading + p");
    const timestamp = submitted.locator("time");
    await expect(timestamp).toBeVisible();
    const submittedAt = await timestamp.getAttribute("datetime");
    expect(submittedAt).toMatch(/^\d{4}-\d{2}-\d{2}T.+Z$/);
    await expect(submitted).toHaveText(
      `Submitted: ${new Date(submittedAt!).toLocaleString("en-CA", {
        timeZone: "America/Vancouver",
        timeZoneName: "short",
      })}`,
    );
    await expect(submission.locator("details")).not.toHaveAttribute("open");
    for (const [id, heading] of [
      ["account-profile-emergency-contact", "Emergency contact"],
      ["submitted-application-heading", "Volunteer Application"],
      ["account-sessions-heading", "Sessions"],
    ]) {
      if (width < 1024) await menu.locator("summary").click();
      const link = contents.getByRole("link", { name: heading, exact: true });
      await expect(link).toHaveAttribute("href", `#${id}`);
      await link.focus();
      await link.press("Enter");
      await expect(page).toHaveURL(new RegExp(`#${id}$`));
      await expect(page.locator(`#${id}`)).toBeFocused();
      await expect(
        contents.locator(`a[href="#${id}"][aria-current="location"]`),
      ).toHaveCount(2);
      if (width < 1024)
        await expect(contents.locator("[data-contents-current]")).toHaveText(
          heading,
        );
    }
    await expect(page.locator('[name="preferredName"]')).toBeHidden();
    await expect(
      page.locator('[data-profile-answer="preferredName"] dd'),
    ).toHaveText(sampleAnswers.preferredName);
    await expect(page.locator("[data-profile-actions]:visible")).toHaveCount(0);
  }
});

test("both phone inputs format typing, paste and edits without trapping the caret", async ({
  page,
  baseURL,
}) => {
  await createLocalAccount(page.request, baseURL!, false);
  await page.goto("/apply");
  const form = page.locator("[data-account-profile]");
  for (const name of ["phone", "emergencyPhone"]) {
    const input = form.locator(`[name="${name}"]`);
    await input.pressSequentially("6045");
    await expect(input).toHaveValue("604-5");
    await input.pressSequentially("550100");
    await expect(input).toHaveValue("604-555-0100");
    await expect(input).toBeFocused();
    expect(
      await input.evaluate((field: HTMLInputElement) => field.selectionStart),
    ).toBe(12);

    // Browser insertion follows the same input path as paste/autofill.
    await input.selectText();
    await page.keyboard.insertText("+1 (604) 555.0199 x123");
    await expect(input).toHaveValue("+1-604-555-0199 x123");

    await input.fill("6045550100");
    await input.evaluate((field: HTMLInputElement) =>
      field.setSelectionRange(4, 4),
    );
    await input.press("Backspace");
    await expect(input).toHaveValue("605-550-100");
    expect(
      await input.evaluate((field: HTMLInputElement) => field.selectionStart),
    ).toBe(2);
    await input.pressSequentially("4");
    await expect(input).toHaveValue("604-555-0100");
    expect(
      await input.evaluate((field: HTMLInputElement) => field.selectionStart),
    ).toBe(3);

    await input.press("Delete");
    await expect(input).toHaveValue("604-550-100");
    await input.pressSequentially("5");
    await expect(input).toHaveValue("604-555-0100");
    expect(
      await input.evaluate((field: HTMLInputElement) => field.selectionStart),
    ).toBe(5);

    await input.evaluate((field: HTMLInputElement) =>
      field.setSelectionRange(4, 7),
    );
    await input.pressSequentially("777");
    await expect(input).toHaveValue("604-777-0100");
    await input.fill("+44 20 7946 0958");
    await expect(input).toHaveValue("+44 20 7946 0958");
    await input.fill("+44-20-7946-0958");
    await input.evaluate((field: HTMLInputElement) =>
      field.setSelectionRange(4, 4),
    );
    await input.press("Backspace");
    await expect(input).toHaveValue("+4420-7946-0958");
    await input.fill("");
    await input.pressSequentially("6045550100");
    for (let count = 0; count < 10; count++) await input.press("Backspace");
    await expect(input).toHaveValue("");
  }
});

test("formatted phones survive draft reloads and profile saves and resets", async ({
  page,
  baseURL,
}) => {
  await createLocalAccount(page.request, baseURL!, false);
  await page.goto("/apply");
  const form = page.locator("[data-account-profile]");
  const phone = form.locator('[name="phone"]');
  const emergency = form.locator('[name="emergencyPhone"]');
  await phone.fill("6045550100");
  await emergency.fill("7785550101");
  await page.reload();
  await expect(phone).toHaveValue("604-555-0100");
  await expect(emergency).toHaveValue("778-555-0101");

  const submitted = await page.request.post("/api/v1/account/profile", {
    headers: { origin: baseURL! },
    data: {
      ...sampleAnswers,
      phone: "6045550100",
      emergencyPhone: "6045550101",
      codeOfConductAccepted: true,
    },
  });
  expect(submitted.status(), await submitted.text()).toBe(200);
  await page.goto("/volunteer/account");
  await page.getByRole("button", { name: "Edit personal info" }).click();
  const save = form
    .getByRole("button", { name: "Save", exact: true, includeHidden: true })
    .first();
  await expect(phone).toHaveValue("604-555-0100");
  await expect(emergency).toHaveValue("604-555-0101");
  await expect(save).toBeDisabled();
  await phone.fill("6045550100");
  await expect(save).toBeDisabled();
  await phone.fill("7785550199");
  await form.evaluate((element: HTMLFormElement) => element.reset());
  await expect(phone).toHaveValue("604-555-0100");
  await expect(save).toBeDisabled();
  await phone.fill("7785550199");
  await save.click();
  await expect(
    form.locator('[data-profile-answers="personal-info"]'),
  ).toBeVisible();
  await expect(form.locator('[data-profile-answer="phone"] dd')).toHaveText(
    "778-555-0199",
  );
  await expect(form.locator("[data-form-message]")).toBeHidden();
  await page.getByRole("button", { name: "Edit emergency contact" }).click();
  await emergency.fill("+1 (604) 555-0199 x123");
  const emergencySave = form.locator(
    '[data-profile-fields="emergency-contact"] button[type="submit"]',
  );
  await expect(emergencySave).toBeEnabled();
  await emergencySave.click();
  await expect(
    form.locator('[data-profile-answers="emergency-contact"]'),
  ).toBeVisible();
  await expect(
    form.locator('[data-profile-answer="emergencyPhone"] dd'),
  ).toHaveText("+1-604-555-0199 x123");
  await expect(form.locator("[data-form-message]")).toBeHidden();
  await expect(save).toBeDisabled();
  await page.reload();
  await page.getByRole("button", { name: "Edit personal info" }).click();
  await expect(phone).toHaveValue("778-555-0199");
  await expect(emergency).toHaveValue("+1-604-555-0199 x123");
  await phone.fill("6045550123");
  await form.evaluate((element: HTMLFormElement) => element.reset());
  await expect(phone).toHaveValue("778-555-0199");
  await expect(save).toBeDisabled();
});

test("application shows all required errors and saves after they are corrected", async ({
  page,
  baseURL,
}) => {
  await createLocalAccount(page.request, baseURL!, false);
  await page.goto("/apply");
  const form = page.locator("[data-account-profile]");
  await expect(form.getByRole("heading", { level: 3 })).toHaveText([
    "Personal info",
    "Emergency contact",
    "Team interests",
    "Training and safety",
    "About volunteering",
  ]);
  await expect(form.locator('input[type="email"]')).toHaveCount(0);
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
  const contents = page.getByRole("navigation", {
    name: "Sections",
  });
  await form.locator("#application-emergency-contact > summary").click();
  await contents
    .getByRole("link", { name: "Emergency contact", exact: true })
    .click();
  await expect(form.locator("#application-emergency-contact")).toHaveAttribute(
    "open",
    "",
  );
  await expect(
    form.locator("#application-emergency-contact > summary"),
  ).toBeFocused();
  await expect(
    contents.locator(
      'a[href="#application-emergency-contact"][aria-current="location"]',
    ),
  ).toHaveCount(2);
  await contents.getByRole("link", { name: "Overview", exact: true }).click();
  await expect.poll(() => page.evaluate(() => scrollY)).toBe(0);
  await expect(emergencyContact.locator("input")).toHaveCount(3);
  await expect(
    form
      .getByRole("group", { name: "About volunteering", exact: true })
      .locator("input, textarea"),
  ).toHaveCount(6);
  const training = form.getByRole("group", {
    name: "Training and safety",
    exact: true,
  });
  await expect(training).toBeVisible();
  await expect(training.locator('[name="experience"]')).toBeHidden();
  await expect(training.locator("[data-medic-certifications]")).toBeHidden();
  await expect(training.locator("[required]")).toHaveCount(1);
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
  await expect(localApplicationReviewButton(page)).toBeEnabled();
  await expect(form.locator("[data-error]:visible")).toHaveCount(0);
  await reviewLocalApplication(page);
  const required = form.locator(
    "input[required]:enabled, textarea[required]:enabled",
  );
  const count = await required.count();
  expect(count).toBeGreaterThan(1);
  // The three DOB inputs share one group error.
  await expect(form.locator("[data-error]:visible")).toHaveCount(count - 2);
  for (const input of await required.all()) {
    expect(
      await input.evaluate((element) => element.matches(":user-invalid")),
    ).toBe(true);
    const id = await input.getAttribute("id");
    const name = await input.getAttribute("name");
    const label =
      !name || ["heardAboutUsSources", "training"].includes(name)
        ? input.locator("xpath=ancestor::fieldset[1]/legend")
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
  await fillApplicationField(form, "birthDate", "2999-01-01");
  await expect(form.locator("[data-error=birthDate]")).toContainText(
    "at least 19 years old",
  );
  await expect(form.locator("[data-error=birthDate]")).toBeVisible();
  expect(requests).toEqual([]);
  for (const [field, value] of Object.entries(sampleAnswers)) {
    if (field === "heardAboutUsSources" || field === "training") {
      for (const source of value as string[])
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
      await fillApplicationField(form, field, String(value));
  }
  await page.setViewportSize({ width: 375, height: 812 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
  ).toBe(false);
  await reviewLocalApplication(page);
  await expect(form.locator('[data-review-answer="email"]')).toHaveCount(0);
  const conduct = form.getByRole("region", {
    name: "Code of Conduct",
    exact: true,
  });
  await expect(contents).toBeHidden();
  await page
    .getByRole("button", { name: "Back to answers", exact: true })
    .click();
  await expect(contents).toBeVisible();
  await expect(
    form.locator("#application-personal-info > summary"),
  ).toBeFocused();
  await reviewLocalApplication(page);
  await expect(contents).toBeHidden();
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
  await page.getByRole("button", { name: "Edit personal info" }).click();
  await expect(form.locator('[name="firstName"]')).toHaveCount(0);
  await expect(
    page.getByRole("textbox", { name: /^Preferred name/ }),
  ).toHaveValue(sampleAnswers.preferredName);
  await expect(
    page.getByRole("region", { name: "Code of Conduct", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.locator(
      '[name="heardAboutUsSources"], [name="heardAboutUsOther"], [name="motivation"]',
    ),
  ).toHaveCount(0);
  await expect(
    page
      .getByRole("button", { name: "Save", exact: true, includeHidden: true })
      .first(),
  ).toBeDisabled();
  // Editing reuses validation and returns to saved text without a success message.
  await page
    .getByRole("textbox", { name: /^Preferred name/ })
    .fill("Updated volunteer");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  const saved = form.locator('[data-profile-answer="preferredName"] dd');
  await expect(saved).toBeVisible();
  await expect(saved).toHaveText("Updated volunteer");
  await expect(form.locator("[data-form-message]")).toBeHidden();
  await expect(
    page
      .getByRole("button", { name: "Save", exact: true, includeHidden: true })
      .first(),
  ).toBeDisabled();
  await page.reload();
  await page.getByRole("button", { name: "Edit personal info" }).click();
  await expect(
    page.getByRole("textbox", { name: /^Preferred name/ }),
  ).toHaveValue("Updated volunteer");
});

test("mobile birth-date entry stays blank, labelled and within the form", async ({
  browser,
  baseURL,
}) => {
  for (const device of ["Pixel 7", "iPhone 13"]) {
    const context = await browser.newContext({
      ...devices[device],
      baseURL,
    });
    try {
      await createLocalAccount(context.request, baseURL!, false);
      const page = await context.newPage();
      await page.goto("/apply");
      const form = page.locator("[data-account-profile]");
      const birthDate = form.getByRole("group", {
        name: "Date of birth",
        exact: true,
      });
      for (const part of ["day", "month", "year"]) {
        const input = birthDate.locator(`[data-birth-date-part="${part}"]`);
        await expect(input).toHaveAccessibleName(
          part[0].toUpperCase() + part.slice(1),
        );
        await expect(input).toHaveAttribute("type", "text");
        await expect(input).toHaveAttribute("inputmode", "numeric");
        await expect(input).toHaveAttribute("autocomplete", `bday-${part}`);
        await expect(input).not.toHaveAttribute("name");
        await expect(input).toHaveAccessibleDescription(
          /at least 19 years old/,
        );
        await expect(input).toHaveValue("");
        await input.focus();
        await expect(input).toHaveValue("");
      }
      await expect(form.locator("[data-error=birthDate]")).toBeHidden();
      const day = birthDate.getByRole("textbox", { name: "Day", exact: true });
      const month = birthDate.getByRole("textbox", {
        name: "Month",
        exact: true,
      });
      const year = birthDate.getByRole("textbox", {
        name: "Year",
        exact: true,
      });
      await day.pressSequentially("010");
      await expect(day).toBeFocused();
      await expect(day).toHaveValue("010");
      await day.press("Home");
      await day.press("Delete");
      await expect(day).toHaveValue("10");
      await day.press("Tab");
      await expect(month).toBeFocused();
      await month.press("Shift+Tab");
      await expect(day).toBeFocused();
      for (const width of [devices[device].viewport.width, 320]) {
        await page.setViewportSize({ width, height: 844 });
        expect(
          await birthDate.evaluate((group) => {
            const field = group.getBoundingClientRect();
            return (
              [...group.querySelectorAll('input[type="text"]')].every(
                (input) => {
                  const bounds = input.getBoundingClientRect();
                  return (
                    bounds.left >= field.left &&
                    bounds.right <= field.right &&
                    bounds.right <= innerWidth
                  );
                },
              ) && document.documentElement.scrollWidth <= innerWidth
            );
          }),
        ).toBe(true);
      }

      // Draft restoration can report a changed value through change, not input.
      await fillApplicationField(form, "birthDate", "1990-01-01");
      await year.evaluate((input: HTMLInputElement) => {
        input.value = "2999";
        input.dispatchEvent(new Event("change", { bubbles: true }));
      });
      await expect(year).toHaveJSProperty(
        "validationMessage",
        applicationBirthDateError,
      );
      await form.evaluate((element: HTMLFormElement) => element.reset());
      await expect(day).toHaveValue("");
      await expect(month).toHaveValue("");
      await expect(year).toHaveValue("");
      await expect(form.locator('[name="birthDate"]')).toHaveValue("");
      await expect(form.locator("[data-error=birthDate]")).toBeHidden();
      expect(
        await year.evaluate(
          (input: HTMLInputElement) => input.validity.valueMissing,
        ),
      ).toBe(true);
    } finally {
      await context.close();
    }
  }
});

test("applications validate the birthday boundary and profiles keep the saved birth date", async ({
  page,
  baseURL,
}) => {
  await createLocalAccount(page.request, baseURL!, false);
  await page.goto("/apply");
  const form = page.locator("[data-account-profile]");
  const birthDate = form.locator('[name="birthDate"]');
  const cutoff = latestApplicationBirthDate();
  const today = new Date();
  expect(cutoff.slice(0, 4)).toBe(String(today.getUTCFullYear() - 19));
  expect(cutoff.slice(5)).toBe(
    today.toISOString().slice(5, 10) === "02-29"
      ? "02-28"
      : today.toISOString().slice(5, 10),
  );
  for (const [field, value] of Object.entries(sampleAnswers)) {
    if (field === "heardAboutUsSources" || field === "training") {
      for (const source of value as string[])
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
      await fillApplicationField(form, field, String(value));
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
  for (const [invalid, part, message] of [
    [underage, "year", applicationBirthDateError],
    [today.toISOString().slice(0, 10), "year", applicationBirthDateError],
    [
      "2005-02-29",
      "day",
      "Enter a real date of birth. Check the day and month.",
    ],
    ["1899-12-31", "year", "Enter a four-digit year of 1900 or later."],
    ["1990-13-01", "month", "Enter a month from 1 to 12."],
    ["1990-01-no", "day", "Enter a day from 1 to 31."],
  ]) {
    await fillApplicationField(form, "birthDate", invalid);
    await reviewLocalApplication(page);
    await expect(
      form.locator(`[data-birth-date-part="${part}"]`),
    ).toBeFocused();
    await expect(form.locator("[data-error=birthDate]")).toBeVisible();
    await expect(form.locator("[data-error=birthDate]")).toHaveText(message);
    expect(requests).toEqual([]);
    await expect(page).toHaveURL(/\/apply$/);
  }
  await fillApplicationField(form, "birthDate", cutoff);
  await expect(form.locator("[data-error=birthDate]")).toBeHidden();
  await reviewLocalApplication(page);
  await expect(form.locator('[data-review-answer="birthDate"]')).toHaveText(
    new Intl.DateTimeFormat("en-CA", {
      dateStyle: "long",
      timeZone: "UTC",
    }).format(new Date(`${cutoff}T00:00:00Z`)),
  );
  await form.locator('[name="codeOfConductAccepted"]').check();
  await page
    .getByRole("button", { name: "Submit application", exact: true })
    .click();
  await expect(page).toHaveURL(/\/volunteer\/account$/);
  expect(requests).toHaveLength(1);
  await page.getByRole("button", { name: "Edit personal info" }).click();
  await expect(birthDate).toHaveCount(0);
  const submission = page.locator("[data-submitted-application]");
  await submission
    .getByText("View submitted application", { exact: true })
    .click();
  await expect(submission.getByText(cutoff, { exact: true })).toBeVisible();
  expect(requests).toHaveLength(1);
  await page.reload();
  await expect(birthDate).toHaveCount(0);
  await submission
    .getByText("View submitted application", { exact: true })
    .click();
  await expect(submission.getByText(cutoff, { exact: true })).toBeVisible();
});

test("the application requires JavaScript and renders blank DOB format guidance", async ({
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
    const birthDate = form.locator('[data-birth-date-part="year"]');
    await expect(birthDate).toHaveAttribute("type", "text");
    await expect(birthDate).toHaveValue("");
    await expect(form.locator("#help-birthDate")).toHaveText(
      "You must be at least 19 years old to apply.",
    );
    await birthDate.fill("not-a-year");
    await expect(localApplicationReviewButton(page)).toBeDisabled();
    expect(
      await birthDate.evaluate(
        (input: HTMLInputElement) => input.validity.valid,
      ),
    ).toBe(false);
    await expect(page).toHaveURL(/\/apply$/);
    await fillApplicationField(form, "birthDate", latestApplicationBirthDate());
    expect(
      await birthDate.evaluate(
        (input: HTMLInputElement) => input.validity.valid,
      ),
    ).toBe(true);
    await page.setViewportSize({ width: 390, height: 844 });
    const reviewButtons = page.locator("[data-application-review]");
    await expect(reviewButtons).toHaveCount(3);
    for (const button of await reviewButtons.all())
      await expect(button).toBeDisabled();
    await expect(localApplicationReviewButton(page)).toBeHidden();
    await expect(localApplicationReviewButton(page, "bottom")).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Review application" }),
    ).toHaveCount(1);
    const contents = page.getByRole("navigation", { name: "Sections" });
    const menu = contents.locator("[data-contents-menu]");
    await expect(contents).toHaveCSS("position", "sticky");
    await expect(contents.locator(".volunteer-contents-sidebar")).toBeHidden();
    await expect(menu).toBeVisible();
    await expect(menu.locator("[data-contents-current]")).toHaveText(
      "Sections",
    );
    await menu.locator("summary").press("Enter");
    await expect(menu).toHaveAttribute("open", "");
    await menu
      .getByRole("link", { name: "Emergency contact", exact: true })
      .click();
    await menu.locator("summary").press("Enter");
    await expect(menu).not.toHaveAttribute("open");
    await expect.poll(async () => (await contents.boundingBox())!.y).toBe(0);
    const barHeight = (await contents.boundingBox())!.height;
    expect(
      Math.round(
        (await page.locator("#application-emergency-contact").boundingBox())!.y,
      ),
    ).toBeGreaterThanOrEqual(barHeight + 16);
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
  const none = training.getByRole("checkbox", {
    name: "No relevant training or experience",
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
  await expect(naloxone).toHaveAttribute("required", "");
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
    if (field === "heardAboutUsSources" || field === "training") {
      for (const source of value as string[])
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
      await fillApplicationField(form, field, String(value));
  }
  await none.uncheck();
  await reviewLocalApplication(page);
  await expect(naloxone).toBeFocused();
  await expect(training.locator("[data-error=training]")).toBeVisible();
  expect(requests).toHaveLength(0);
  await none.check();
  await reviewLocalApplication(page);
  await expect(form.locator('[data-review-answer="training"]')).toHaveText(
    "No relevant training or experience",
  );
  await form
    .getByRole("button", { name: "Back to answers", exact: true })
    .click();
  await naloxone.check();
  await crisis.check();
  await none.check();
  await expect(training.locator(":checked")).toHaveCount(1);
  await naloxone.check();
  await expect(none).not.toBeChecked();
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
    await reviewLocalApplication(page);
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
  await page.getByRole("button", { name: "Edit training and safety" }).click();
  await expect(medic).not.toBeChecked();
  await expect(support).toBeChecked();
  await expect(naloxone).toBeChecked();
  await expect(crisis).toBeChecked();
  await expect(other).toBeChecked();
  await expect(otherText).toHaveValue("Crisis intervention course");
  const save = form
    .locator('[data-profile-fields="training-and-safety"]')
    .getByRole("button", { name: "Save", exact: true, includeHidden: true })
    .first();
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
  await expect(
    form.locator('[data-profile-answers="training-and-safety"]'),
  ).toBeVisible();
  await expect(form.locator("[data-form-message]")).toBeHidden();
  await expect(
    form.locator('[data-profile-answer="training"] dd'),
  ).toContainText("Naloxone administration training");
  await expect(
    form.locator('[data-profile-answer="otherTraining"]'),
  ).toBeHidden();
  await page.reload();
  await page.getByRole("button", { name: "Edit training and safety" }).click();
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
  await expect(naloxone).toBeFocused();
  expect(requests).toHaveLength(savedRequests);
  await none.check();
  await save.click();
  await expect(
    form.locator('[data-profile-answers="training-and-safety"]'),
  ).toBeVisible();
  await expect(form.locator('[data-profile-answer="training"] dd')).toHaveText(
    "No relevant training or experience",
  );
  await expect(form.locator("[data-form-message]")).toBeHidden();
  await page.reload();
  await page.getByRole("button", { name: "Edit training and safety" }).click();
  await expect(training).toBeVisible();
  await expect(training.locator(":checked")).toHaveCount(1);
  await expect(none).toBeChecked();
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
    if (field === "heardAboutUsSources" || field === "training") {
      for (const source of value as string[])
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
      await fillApplicationField(form, field, String(value));
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
  await reviewLocalApplication(page);
  await expect(firstAid).toBeFocused();
  await expect(
    certifications.locator("[data-error=certifications]"),
  ).toBeVisible();
  await firstAid.press("Space");
  await expect(firstAid).toBeChecked();
  await reviewLocalApplication(page);
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
    await reviewLocalApplication(page);
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
  for (const [name, value] of [
    ["certifications", "Other"],
    ["certificationExpiry", "2030-10-14"],
    ["experience", "Naloxone training"],
  ]) {
    const answer = form.locator(`[data-profile-answer="${name}"] dd`);
    await expect(answer).toBeVisible();
    await expect(answer).toHaveText(value);
  }
  await page.getByRole("button", { name: "Edit team interests" }).click();
  await expect(medic).toBeChecked();
  await expect(certifications).toBeVisible();
  await expect(other).toBeChecked();
  await expect(certifications.locator(":checked")).toHaveCount(1);
  await expect(expiry).toHaveValue("2030-10-14");
  await expect(experience).toBeEditable();
  await expect(experience).toHaveValue("Naloxone training");
  const save = form
    .locator('[data-profile-fields="team-interests"]')
    .getByRole("button", { name: "Save", exact: true, includeHidden: true })
    .last();
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
  await expect(
    form.locator('[data-profile-answers="team-interests"]'),
  ).toBeVisible();
  await expect(form.locator("[data-form-message]")).toBeHidden();
  for (const name of ["certifications", "certificationExpiry", "experience"])
    await expect(form.locator(`[data-profile-answer="${name}"]`)).toBeHidden();
  await page.reload();
  await page.getByRole("button", { name: "Edit team interests" }).click();
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
  await expect(
    form.locator('[data-profile-answers="team-interests"]'),
  ).toBeVisible();
  await expect(
    form.locator('[data-profile-answer="certifications"] dd'),
  ).toHaveText("Advanced First Aid (formerly OFA Level 3)");
  await expect(form.locator("[data-form-message]")).toBeHidden();
  await page.reload();
  await page.getByRole("button", { name: "Edit team interests" }).click();
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

test("profile sections edit in isolation, preserve saved answers, and cancel to the latest save", async ({
  page,
  baseURL,
}) => {
  const { email } = await createLocalAccount(page.request, baseURL!);
  const certifications = ["advanced-first-aid", "nurse"];
  const seeded = await page.request.post("/api/v1/account/profile", {
    headers: { origin: baseURL! },
    data: {
      ...sampleAnswers,
      certifications,
      experience: "Saved experience",
      certificationExpiry: "2030-10-14",
    },
  });
  expect(seeded.status(), await seeded.text()).toBe(200);
  await page.goto("/volunteer/account");
  const form = page.locator("[data-account-profile]");
  await expect(form.locator('input[type="email"]')).toHaveCount(0);
  const settings = page.locator(".volunteer-panel").filter({
    has: page.getByRole("heading", { name: "Account settings", exact: true }),
  });
  await expect(settings.getByText(email, { exact: true })).toBeVisible();
  const edit = page.getByRole("button", { name: "Edit emergency contact" });
  const editor = form.locator("[data-profile-editor]");
  const actions = form.locator("[data-profile-actions]");
  const visibleActions = form.locator("[data-profile-actions]:visible");
  const enabledSaves = form.locator(
    '[data-profile-actions] button[type="submit"]:enabled',
  );
  const preferredName = form.locator('[name="preferredName"]');
  const name = form.locator('[name="emergencyName"]');
  const medicalConditions = form.locator('[name="medicalConditions"]');
  const answer = (name: string) =>
    form.locator(`[data-profile-answer="${name}"] dd`);
  const expectTextView = async (contact = sampleAnswers.emergencyName) => {
    await expect(form.locator("[data-profile-answers]:visible")).toHaveCount(4);
    await expect(
      form.locator("input:visible, textarea:visible, select:visible"),
    ).toHaveCount(0);
    await expect(answer("emergencyName")).toBeVisible();
    await expect(answer("emergencyName")).toHaveText(contact);
    await expect(answer("teams").getByRole("listitem")).toHaveText([
      "Outreach",
    ]);
    await expect(answer("training")).toHaveText(
      "No relevant training or experience",
    );
    for (const conditional of [
      "certifications",
      "certificationExpiry",
      "experience",
      "otherTraining",
    ])
      await expect(answer(conditional)).toBeHidden();
  };
  await expect(editor).toBeVisible();
  await expect(editor).toHaveAccessibleName("Profile details");
  await expect(preferredName).toHaveCount(1);
  await expect(preferredName).toHaveValue(sampleAnswers.preferredName);
  await expect(preferredName).toBeDisabled();
  await expect(name).toBeDisabled();
  await expect(form.getByLabel("Medic", { exact: true })).toBeDisabled();
  await expectTextView();
  await expect(actions).toHaveCount(4);
  await expect(form.locator("[data-profile-edit] svg")).toHaveCount(4);
  await expect(visibleActions).toHaveCount(0);
  const requests: Record<string, unknown>[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/v1/account/profile")
      requests.push(request.postDataJSON());
  });
  await form.evaluate((element: HTMLFormElement) => element.requestSubmit());
  expect(requests).toEqual([]);
  const submission = page.locator("[data-submitted-application]");
  await submission
    .getByText("View submitted application", { exact: true })
    .click();
  for (const [field, label] of [
    ["firstName", "First name"],
    ["middleNames", "Middle name(s)"],
    ["lastName", "Last name"],
    ["birthDate", "Date of birth"],
  ] as const) {
    await expect(form.locator(`[name="${field}"]`)).toHaveCount(0);
    await expect(
      submission
        .locator("dl > div")
        .filter({ has: page.getByText(label, { exact: true }) })
        .locator("dd"),
    ).toHaveText(sampleAnswers[field]);
  }
  await expect(
    form.locator(
      '[name="heardAboutUs"], [name="heardAboutUsSources"], [name="heardAboutUsOther"], [name="motivation"]',
    ),
  ).toHaveCount(0);
  await edit.click();
  const contactFields = form.locator(
    '[data-profile-fields="emergency-contact"]',
  );
  const save = contactFields.getByRole("button", {
    name: "Save",
    exact: true,
    includeHidden: true,
  });
  const cancel = contactFields.getByRole("button", {
    name: "Cancel",
    exact: true,
    includeHidden: true,
  });
  await expect(visibleActions).toHaveCount(1);
  await expect(enabledSaves).toHaveCount(0);
  await expect(name).toBeFocused();
  await expect(form.locator("[data-profile-answers]:visible")).toHaveCount(3);
  await expect(form.locator("[data-profile-fields]:visible")).toHaveCount(1);
  await expect(
    page.getByRole("button", { name: "Edit personal info" }),
  ).toBeDisabled();
  await expect(preferredName).toBeHidden();
  await expect(preferredName).toBeDisabled();
  await expect(name).toBeEditable();
  await expect(editor.locator(".volunteer-fields").first()).toHaveCSS(
    "opacity",
    "1",
  );
  for (const field of [name]) {
    await expect(field).toBeEditable();
    await expect(field).toHaveCSS("color", "rgb(244, 244, 245)");
    await expect(field).toHaveCSS("background-color", "rgb(5, 6, 8)");
  }
  await name.fill("");
  await save.click();
  await cancel.click();
  await expect(edit).toBeFocused();
  await expect(editor).toBeVisible();
  await expect(name).toBeDisabled();
  await expect(name).toHaveValue(sampleAnswers.emergencyName);
  await expectTextView();
  await expect(visibleActions).toHaveCount(0);
  await expect(form.locator("[data-form-message]")).toBeHidden();
  await edit.click();
  await expect(name).toHaveValue(sampleAnswers.emergencyName);
  await expect(form.locator("[data-error=emergencyName]")).toBeHidden();
  await expect(enabledSaves).toHaveCount(0);
  await expect(save).toHaveCSS("background-color", "rgb(39, 39, 42)");
  await name.press("Enter");
  await form.evaluate((element: HTMLFormElement) => element.requestSubmit());
  expect(requests).toEqual([]);

  for (const [field, changed] of [
    ["emergencyName", "Updated contact"],
    ["emergencyPhone", "604-555-0199"],
    ["emergencyRelationship", "Sibling"],
  ] as const) {
    const input = form.locator(`[name="${field}"]`);
    await input.fill(changed);
    await expect(enabledSaves).toHaveCount(1);
    await input.fill(sampleAnswers[field]);
    await expect(enabledSaves).toHaveCount(0);
  }
  await name.fill(` ${sampleAnswers.emergencyName} `);
  await expect(enabledSaves).toHaveCount(0);
  await name.fill("Reset this draft");
  await expect(enabledSaves).toHaveCount(1);
  await form.evaluate((element: HTMLFormElement) => element.reset());
  await expect(enabledSaves).toHaveCount(0);

  await name.fill("");
  await save.click();
  await expect(form.locator("[data-error=emergencyName]")).toHaveText(
    "This field is required.",
  );
  await expect(form.locator("[data-error=emergencyName]")).toBeVisible();
  expect(requests).toEqual([]);
  await name.fill(sampleAnswers.emergencyName);
  await expect(enabledSaves).toHaveCount(0);
  await name.fill("Updated volunteer");
  await expect(enabledSaves).toHaveCount(1);
  await name.press("Enter");
  await expect(contactFields).toBeHidden();
  await expect(form.locator("[data-form-message]")).toBeHidden();
  await expect(enabledSaves).toHaveCount(0);
  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({
    preferredName: sampleAnswers.preferredName,
    phone: sampleAnswers.phone,
    training: sampleAnswers.training,
    certifications,
    experience: "Saved experience",
    certificationExpiry: "2030-10-14",
  });
  for (const immutable of [
    "firstName",
    "middleNames",
    "lastName",
    "birthDate",
    "motivation",
    "heardAboutUs",
  ])
    expect(requests[0]).not.toHaveProperty(immutable);
  await expect(editor).toBeVisible();
  await expect(name).toHaveValue("Updated volunteer");
  await expect(name).toBeDisabled();
  await expectTextView("Updated volunteer");
  await expect(visibleActions).toHaveCount(0);
  await expect(edit).toBeFocused();
  await edit.click();
  await name.fill(sampleAnswers.emergencyName);
  await expect(enabledSaves).toHaveCount(1);
  await cancel.click();
  await expectTextView("Updated volunteer");
  await expect(visibleActions).toHaveCount(0);
  await expect(edit).toBeFocused();
  await edit.click();
  await expect(name).toHaveValue("Updated volunteer");
  await expect(enabledSaves).toHaveCount(0);
  await page.reload();
  await expect(name).toHaveValue("Updated volunteer");
  await expect(enabledSaves).toHaveCount(0);
  await expectTextView("Updated volunteer");

  // Clearing the preferred name still falls back to the saved legal name.
  await page.getByRole("button", { name: "Edit personal info" }).click();
  const safetyAnswer = "First line\n<em>Text, not markup</em>";
  await medicalConditions.fill(safetyAnswer);
  await form.locator('[name="preferredName"]').fill("");
  await form.getByRole("button", { name: "Save", exact: true }).click();
  await expect(
    form.locator('[data-profile-answers="personal-info"]'),
  ).toBeVisible();
  await expect(form.locator("[data-form-message]")).toBeHidden();
  await expect(page.locator("[data-account-menu-name]").first()).toHaveText(
    `${sampleAnswers.firstName} ${sampleAnswers.middleNames} ${sampleAnswers.lastName}`,
  );
  await expect(page.locator("[data-account-greeting]")).toHaveText(
    sampleAnswers.firstName,
  );
  await expect(answer("preferredName")).toHaveText("Not provided");
  await expect(answer("medicalConditions")).toHaveText(safetyAnswer);
  await expect(answer("medicalConditions").locator("em")).toHaveCount(0);
  await page.reload();
  await expect(answer("medicalConditions")).toHaveText(safetyAnswer);
  await expectTextView("Updated volunteer");
  await page.getByRole("button", { name: "Edit team interests" }).click();
  await expect(
    form.getByRole("button", { name: "Save", exact: true }),
  ).toBeDisabled();
  await form.getByLabel("Non-patrol support", { exact: true }).check();
  await form.getByRole("button", { name: "Save", exact: true }).click();
  await expect(
    form.locator('[data-profile-answers="team-interests"]'),
  ).toBeVisible();
  await expect(answer("teams").getByRole("listitem")).toHaveText([
    "Outreach",
    "Non-patrol support",
  ]);
  await expect(form.locator("[data-form-message]")).toBeHidden();
  expect(requests[2].certifications).toEqual(certifications);
});

test("Outreach stays selected while optional teams support cards, keyboard input and reset", async ({
  page,
  baseURL,
}) => {
  await createLocalAccount(page.request, baseURL!);
  await page.goto("/volunteer/account");
  await page.getByRole("button", { name: "Edit team interests" }).click();
  const form = page.locator("[data-account-profile]");
  const outreach = form.getByLabel("Outreach", { exact: true });
  const medic = form.getByLabel("Medic", { exact: true });
  const support = form.getByLabel("Non-patrol support", { exact: true });
  const save = form
    .locator('[data-profile-fields="team-interests"]')
    .getByRole("button", { name: "Save", exact: true, includeHidden: true })
    .first();
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
  await expect(
    form.locator('[data-profile-answers="team-interests"]'),
  ).toBeVisible();
  await expect(form.locator("[data-form-message]")).toBeHidden();
  await page.reload();
  await expect(outreach).toBeChecked();
  await expect(outreach).toBeDisabled();
  await expect(support).toBeChecked();
  await expect(training).toBeHidden();
  expect(requests).toHaveLength(1);

  // Medic's dependent fields stay inside the open Team interests section;
  // Training and safety remains saved text until its own Edit is selected.
  await page.getByRole("button", { name: "Edit team interests" }).click();
  await medic.check();
  await expect(
    form.locator('[data-profile-answers="training-and-safety"]'),
  ).toBeVisible();
  await expect(
    form.locator(
      '[data-profile-fields="team-interests"] [data-medic-certifications]',
    ),
  ).toBeVisible();
  await save.click();
  const firstAid = training.getByRole("radio", {
    name: "Advanced First Aid (formerly OFA Level 3)",
    exact: true,
  });
  await expect(firstAid).toBeFocused();
  expect(requests).toHaveLength(1);
  await firstAid.check();
  const expiry = form.locator('[name="certificationExpiry"]');
  await expiry.fill("2030-10-14");
  await save.click();
  await expect(
    form.locator('[data-profile-answer="certificationExpiry"] dd'),
  ).toHaveText("2030-10-14");
  await expect(form.locator("[data-profile-answers]:visible")).toHaveCount(4);
  await page.getByRole("button", { name: "Edit training and safety" }).click();
  await expect(
    form.locator(
      '[data-profile-fields="training-and-safety"] [data-medic-certifications]',
    ),
  ).toBeVisible();
  await expiry.fill("2031-01-01");
  await form.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(expiry).toHaveValue("2030-10-14");
  await expect(medic).toBeChecked();
});

test("email changes verify the new address in place and preserve unsaved profile answers", async ({
  page,
  baseURL,
}) => {
  const { id, email } = await createLocalAccount(page.request, baseURL!);
  await page.goto("/volunteer/account");
  await page.getByRole("button", { name: "Edit personal info" }).click();
  const name = page.getByRole("textbox", {
    name: /^Preferred name/,
  });
  await name.fill("Unsaved email-change draft");
  const request = page.locator("[data-email-change-request]");
  const confirm = page.locator("[data-email-change-confirm]");
  const changeEmail = page.getByRole("button", {
    name: "Change email address",
  });
  await expect(request).toBeHidden();
  await expect(confirm).toBeHidden();
  await changeEmail.click();
  await request.getByLabel("New email address").fill("discard@example.org");
  await page
    .locator("[data-email-settings]")
    .getByRole("button", { name: "Cancel", exact: true })
    .click();
  await expect(changeEmail).toBeFocused();
  await expect(request).toBeHidden();
  await changeEmail.click();
  await expect(request.getByLabel("New email address")).toBeFocused();
  await expect(request.getByLabel("New email address")).toHaveValue("");
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
    newEmail,
  ]);
  await expect(
    page.locator("[data-email-settings] > div > [data-form-message]"),
  ).toHaveAttribute("data-message-kind", "success");
  await expect(request).toBeHidden();
  await expect(changeEmail).toBeFocused();
  await changeEmail.click();
  await expect(request.getByLabel("New email address")).toHaveValue("");
  await expect(code).toHaveValue("");
  await expect(confirm).toBeHidden();
  await expect(name).toHaveValue("Unsaved email-change draft");
  await expect(
    page.getByRole("button", { name: "Save", exact: true }).first(),
  ).toBeEnabled();
  await page.reload();
  await expect(
    page.locator("[data-email-settings] [data-account-email]"),
  ).toHaveText(newEmail);
  await page.getByRole("button", { name: "Edit personal info" }).click();
  await expect(name).toHaveValue(sampleAnswers.preferredName);
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
  await page.getByRole("button", { name: "Change email address" }).click();
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
  await page.route("**/api/v1/auth/email-otp/request-email-change", (route) =>
    route.fulfill({ json: { success: true } }),
  );
  await button.click();
  const confirm = page.locator("[data-email-change-confirm]");
  await expect(confirm).toBeVisible();
  await confirm.getByLabel("Verification code").fill("123456");
  await page
    .locator("[data-email-settings]")
    .getByRole("button", { name: "Cancel", exact: true })
    .click();
  await page.getByRole("button", { name: "Change email address" }).click();
  await expect(request.getByLabel("New email address")).toHaveValue("");
  await expect(confirm).toBeHidden();
  await expect(confirm.locator('[name="code"]')).toHaveValue("");
  await expect(confirm.locator('[name="newEmail"]')).toHaveValue("");
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
  await page.getByRole("button", { name: "Edit personal info" }).click();
  const form = page.locator("[data-account-profile]");
  const saves = form
    .locator('[data-profile-fields="personal-info"]')
    .getByRole("button", {
      name: "Save",
      exact: true,
      includeHidden: true,
    });
  const name = form.locator('[name="preferredName"]');
  await page.route("**/api/v1/account/profile", (route) =>
    route.fulfill({
      status: 503,
      json: { message: "Your profile is temporarily unavailable." },
    }),
  );
  await name.fill("Retry this profile");
  await saves.first().click();
  await expect(form.locator("[data-form-message]")).toHaveText(
    "Your profile is temporarily unavailable.",
  );
  await expect(form.locator("[data-form-message]")).toBeVisible();
  await expect(form.locator("[data-form-message]")).toHaveAttribute(
    "role",
    "alert",
  );
  for (const save of await saves.all()) await expect(save).toBeEnabled();
  await expect(
    form.locator("[data-profile-cancel]:enabled:visible"),
  ).toHaveCount(1);
  await expect(name).toHaveValue("Retry this profile");
  await name.fill(sampleAnswers.preferredName);
  for (const save of await saves.all()) await expect(save).toBeDisabled();
  await name.fill("Retry this profile");
  await page.unroute("**/api/v1/account/profile");
  await saves.last().click();
  const saved = form.locator('[data-profile-answer="preferredName"] dd');
  await expect(saved).toBeVisible();
  await expect(saved).toHaveText("Retry this profile");
  await expect(form.locator("[data-form-message]")).toBeHidden();
  for (const save of await saves.all()) await expect(save).toBeDisabled();
});

test("edits made during a profile save remain unsaved", async ({
  page,
  baseURL,
}) => {
  await createLocalAccount(page.request, baseURL!);
  await page.goto("/volunteer/account");
  await page.getByRole("button", { name: "Edit personal info" }).click();
  const form = page.locator("[data-account-profile]");
  const saves = form
    .locator('[data-profile-fields="personal-info"]')
    .getByRole("button", {
      name: "Save",
      exact: true,
      includeHidden: true,
    });
  const name = form.locator('[name="preferredName"]');
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
    await saves.last().click();
    await expect(form).toHaveAttribute("aria-busy", "true");
    for (const button of await form
      .locator("[data-profile-actions]:visible button")
      .all())
      await expect(button).toBeDisabled();
    await expect(
      page.getByRole("button", { name: "Edit emergency contact" }),
    ).toBeDisabled();
    await name.fill("Second unsaved name");
    for (const save of await saves.all()) await expect(save).toBeDisabled();
    finishSaving();
    await expect(form).not.toHaveAttribute("aria-busy");
    await expect(
      form.locator('[data-profile-answer="preferredName"] dd'),
    ).toHaveText("First saved name");
    await expect(name).toBeVisible();
    await expect(name).toHaveValue("Second unsaved name");
    await expect(form.locator("[data-form-message]")).toBeHidden();
    for (const button of await form
      .locator("[data-profile-actions]:visible button")
      .all())
      await expect(button).toBeEnabled();
    await name.fill("First saved name");
    for (const save of await saves.all()) await expect(save).toBeDisabled();
    await name.fill("Discard this pending-save draft");
    await form.getByRole("button", { name: "Cancel", exact: true }).click();
    await page.getByRole("button", { name: "Edit personal info" }).click();
    await expect(name).toHaveValue("First saved name");
    await name.fill("Second unsaved name");
    await saves.first().click();
    for (const save of await saves.all()) await expect(save).toBeDisabled();
    await expect(form).not.toHaveAttribute("aria-busy");
    await page.reload();
    await page.getByRole("button", { name: "Edit personal info" }).click();
    await expect(name).toHaveValue("Second unsaved name");
    for (const save of await saves.all()) await expect(save).toBeDisabled();
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
  await page.getByRole("button", { name: "Edit personal info" }).click();
  const name = page.getByRole("textbox", {
    name: /^Preferred name/,
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
  const contents = page.getByRole("navigation", { name: "On this page" });
  await contents
    .getByRole("link", { name: "Two-factor authentication", exact: true })
    .click();
  await expect(page.locator("#account-factor-heading")).toBeFocused();
  await expect(
    contents.locator(
      'a[href="#account-factor-heading"][aria-current="location"]',
    ),
  ).toHaveCount(2);
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
