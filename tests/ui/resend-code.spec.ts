import { expect, test, type Page } from "@playwright/test";

const sendEndpoint = "**/api/v1/auth/email-otp/send-verification-otp**";
const verifyEndpoint = "**/api/v1/auth/sign-in/email-otp**";

async function chooseDelivery(page: Page) {
  await page
    .getByRole("button", { name: "Simulate successful delivery" })
    .click();
}

async function startSignIn(page: Page, email = "resend@example.org") {
  await page.goto(
    "/volunteer/sign-in?returnTo=%2Fvolunteer%2Fevents%3Ffrom%3Dresend",
  );
  await page.getByRole("textbox", { name: "Email", exact: true }).fill(email);
  await page.getByRole("button", { name: "Continue with Email" }).click();
  await chooseDelivery(page);
  await expect(page.locator("[data-email-code]")).toBeVisible();
}

async function freezeClock(page: Page) {
  const time = new Date();
  await page.clock.install({ time });
  await page.clock.pauseAt(time);
}

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

test("cooldown starts after successful delivery and enforces both 30-second boundaries", async ({
  page,
}) => {
  await freezeClock(page);
  const requests: { email: string; type: string; returnTo: string | null }[] =
    [];
  let release!: () => void;
  let pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(sendEndpoint, async (route) => {
    requests.push({
      ...route.request().postDataJSON(),
      returnTo: new URL(route.request().url()).searchParams.get("returnTo"),
    });
    await pending;
    await route.fulfill({ json: { success: true } });
  });
  await page.goto(
    "/volunteer/sign-in?returnTo=%2Fvolunteer%2Fevents%3Ffrom%3Dresend",
  );
  const initial = page.getByRole("button", { name: "Continue with Email" });
  const code = page.locator("[data-email-code]");
  const resend = code.locator("[data-resend-code]");
  const resendHelp = code.locator("#sign-in-code-help");
  await page
    .getByRole("textbox", { name: "Email", exact: true })
    .fill("  First@EXAMPLE.org  ");
  await initial.click();
  await chooseDelivery(page);
  await expect.poll(() => requests.length).toBe(1);
  await page.clock.fastForward(60_000);
  await expect(code).toBeHidden();
  await expect(
    page.getByRole("button", { name: "Sending email…" }),
  ).toBeDisabled();
  release();
  await expect(resend).toHaveText("Resend code (30s)");
  await expect(resend).toBeDisabled();
  await expect(resendHelp).toBeHidden();
  await expect(resend).not.toHaveAttribute("aria-describedby");
  await page.clock.fastForward(29_999);
  await expect(resend).toHaveText("Resend code (1s)");
  await expect(resendHelp).toBeHidden();
  await resend.dispatchEvent("click");
  expect(requests).toHaveLength(1);
  await page.clock.fastForward(1);
  await expect(resend).toHaveText("Resend code");
  await expect(resend).toBeEnabled();
  await expect(resendHelp).toBeVisible();
  await expect(resend.locator("+ #sign-in-code-help")).toHaveText(
    "Code or link expired or already used? Choose Resend code for a new email. Only the latest code and link will work.",
  );
  await expect(resend).toHaveAttribute("aria-describedby", "sign-in-code-help");
  // Resending must not validate the empty, required code field.
  pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  await resend.click();
  await expect(resend).toHaveText("Sending email…");
  await expect(resend).toBeDisabled();
  await expect(resendHelp).toBeVisible();
  await expect(resend).toHaveAttribute("aria-busy", "true");
  await chooseDelivery(page);
  await expect.poll(() => requests.length).toBe(2);
  await expect(
    code.getByRole("button", { name: "Sign in with code" }),
  ).toBeDisabled();
  await resend.dispatchEvent("click");
  await code.dispatchEvent("submit");
  await page.locator("[data-email-request]").dispatchEvent("submit");
  await page
    .getByRole("link", { name: "Use a different email" })
    .dispatchEvent("click");
  expect(requests).toHaveLength(2);
  await expect(code).toBeVisible();
  release();
  await expect(resend).toHaveText("Resend code (30s)");
  await expect(resendHelp).toBeVisible();
  await expect(code.locator("[data-form-message]")).toHaveAttribute(
    "role",
    "status",
  );
  await expect(code.locator("[data-form-message]")).toContainText(
    "Only the latest email will work",
  );
  await expect(code.locator('[name="code"]')).toBeFocused();
  await expect(code.locator("[data-error=email-code]")).toBeHidden();
  await page.clock.fastForward(29_999);
  await expect(resend).toBeDisabled();
  await page.clock.fastForward(1);
  await expect(resend).toBeEnabled();
  expect(requests).toEqual(
    Array(2).fill({
      email: "first@example.org",
      type: "sign-in",
      returnTo: "/volunteer",
    }),
  );
  await page.getByRole("link", { name: "Use a different email" }).click();
  await expect(resendHelp).toHaveAttribute("hidden", "");
  await expect(resend).not.toHaveAttribute("aria-describedby");
  await page
    .getByRole("textbox", { name: "Email", exact: true })
    .fill("new@example.org");
  await initial.click();
  await chooseDelivery(page);
  await expect(resend).toHaveText("Resend code (30s)");
  await expect(resendHelp).toBeHidden();
});

test("resend failures and cancellations preserve the email and allow retry without a new cooldown", async ({
  page,
}) => {
  await freezeClock(page);
  let sends = 0;
  let failure: "rate" | "network" | "service" | null = null;
  await page.route(sendEndpoint, async (route) => {
    sends++;
    if (failure === "network") await route.abort();
    else if (failure === "rate")
      await route.fulfill({
        status: 429,
        json: { message: "Too many requests. Try again later." },
      });
    else if (failure === "service")
      await route.fulfill({ status: 503, json: {} });
    else await route.fulfill({ json: { success: true } });
  });
  await startSignIn(page);
  const code = page.locator("[data-email-code]");
  const resend = code.locator("[data-resend-code]");
  const feedback = code.locator("[data-form-message]");
  await code.locator('[name="code"]').fill("123456");
  await page.clock.fastForward(30_000);
  await resend.click();
  await page.getByRole("button", { name: "Close email test" }).click();
  await expect(resend).toBeEnabled();
  expect(sends).toBe(1);
  await resend.click();
  await page.getByRole("button", { name: "Simulate delivery failure" }).click();
  await expect(feedback).toContainText("Simulated locally");
  await expect(resend).toBeEnabled();
  expect(sends).toBe(1);
  for (const [kind, expected] of [
    ["rate", "Too many requests. Try again later."],
    ["network", "We could not connect. Check your connection and try again."],
    [
      "service",
      "This service is temporarily unavailable. Please try again later.",
    ],
  ] as const) {
    failure = kind;
    await resend.click();
    await chooseDelivery(page);
    await expect(feedback).toHaveText(expected);
    await expect(feedback).toHaveAttribute("role", "alert");
    await expect(feedback).toHaveAttribute("aria-live", "assertive");
    await expect(resend).toHaveText("Resend code");
    await expect(resend).toBeEnabled();
    await expect(code.locator('[name="code"]')).toHaveValue("123456");
    await expect(
      page.getByRole("textbox", { name: "Email", exact: true }),
    ).toHaveValue("resend@example.org");
    await expect(
      page.getByRole("textbox", { name: "Email", exact: true }),
    ).not.toBeEditable();
  }
  failure = null;
  await resend.click();
  await chooseDelivery(page);
  await expect(resend).toHaveText("Resend code (30s)");
  await expect(code.locator('[name="code"]')).toHaveValue("");
  await expect(feedback).toHaveAttribute("role", "status");
  expect(sends).toBe(5);
});

test("different-email reset clears the cooldown, code and errors and starts a fresh send", async ({
  page,
}) => {
  await freezeClock(page);
  const emails: string[] = [];
  await page.route(sendEndpoint, async (route) => {
    emails.push(route.request().postDataJSON().email);
    await route.fulfill({ json: { success: true } });
  });
  await page.route(verifyEndpoint, (route) =>
    route.fulfill({
      status: 400,
      json: { code: "OTP_EXPIRED", message: "OTP expired" },
    }),
  );
  await startSignIn(page, "first@example.org");
  const code = page.locator("[data-email-code]");
  await code.locator('[name="code"]').fill("123456");
  await code.getByRole("button", { name: "Sign in with code" }).click();
  await expect(code.locator("[data-form-message]")).toContainText(
    "Choose Resend code",
  );
  await page.clock.fastForward(10_000);
  await page.getByRole("link", { name: "Use a different email" }).click();
  await expect(code).toBeHidden();
  await expect(code.locator('[name="code"]')).toHaveValue("");
  await expect(code.locator('[name="email"]')).toHaveValue("");
  await expect(code).not.toHaveAttribute("data-return-to");
  await expect(code.locator("[data-form-message]")).toBeHidden();
  const input = page.getByRole("textbox", { name: "Email", exact: true });
  await expect(input).toHaveValue("");
  await expect(input).toBeEditable();
  await expect(input).toBeFocused();
  await expect(code.locator("[data-resend-code]")).toHaveText("Resend code");
  await input.fill("second@example.org");
  await page.getByRole("button", { name: "Continue with Email" }).click();
  await chooseDelivery(page);
  await expect(code.locator("[data-resend-code]")).toHaveText(
    "Resend code (30s)",
  );
  await page.clock.fastForward(20_000);
  await expect(code.locator("[data-resend-code]")).toHaveText(
    "Resend code (10s)",
  );
  await expect(code.locator('[name="email"]')).toHaveValue(
    "second@example.org",
  );
  expect(emails).toEqual(["first@example.org", "second@example.org"]);
});

for (const errorCode of ["OTP_EXPIRED", "INVALID_OTP"]) {
  test(`${errorCode} code recovery resends to the same email and keeps two-factor sign-in`, async ({
    page,
  }) => {
    await freezeClock(page);
    const sends: string[] = [];
    await page.route(sendEndpoint, async (route) => {
      sends.push(route.request().postDataJSON().email);
      await route.fulfill({ json: { success: true } });
    });
    let verified = false;
    const proofs: object[] = [];
    await page.route(verifyEndpoint, async (route) => {
      proofs.push(route.request().postDataJSON());
      expect(new URL(route.request().url()).searchParams.get("returnTo")).toBe(
        "/volunteer",
      );
      await route.fulfill(
        verified
          ? { json: { twoFactorRedirect: true } }
          : {
              status: 400,
              json: {
                code: errorCode,
                message:
                  errorCode === "OTP_EXPIRED" ? "OTP expired" : "Invalid OTP",
              },
            },
      );
    });
    await startSignIn(page);
    const code = page.locator("[data-email-code]");
    await page.getByLabel("Six-digit code").fill("123456");
    await code.getByRole("button", { name: "Sign in with code" }).click();
    await expect(code.locator("[data-form-message]")).toContainText(
      "Resend code",
    );
    await expect(code.locator("[data-form-message]")).toHaveAttribute(
      "role",
      "alert",
    );
    await expect(code.locator("[data-resend-code]")).toBeDisabled();
    await page.clock.fastForward(30_000);
    await code.locator("[data-resend-code]").click();
    await chooseDelivery(page);
    await expect(code.locator('[name="code"]')).toHaveValue("");
    verified = true;
    await code.locator('[name="code"]').fill("654321");
    await code.getByRole("button", { name: "Sign in with code" }).click();
    await expect(page.locator("[data-second-factor]")).toBeVisible();
    await expect(code).toBeHidden();
    await expect(page.locator("[data-email-request]")).toBeHidden();
    await expect(
      page.getByRole("link", { name: "Use a different email" }),
    ).toBeHidden();
    expect(sends).toEqual(["resend@example.org", "resend@example.org"]);
    expect(proofs).toEqual([
      { email: "resend@example.org", otp: "123456" },
      { email: "resend@example.org", otp: "654321" },
    ]);
  });

  test(`${errorCode} link recovers in place without putting secrets back in the URL`, async ({
    page,
  }) => {
    await freezeClock(page);
    let verified = false;
    const proofs: object[] = [];
    await page.route(verifyEndpoint, async (route) => {
      proofs.push(route.request().postDataJSON());
      expect(new URL(route.request().url()).searchParams.get("returnTo")).toBe(
        "/volunteer",
      );
      await route.fulfill(
        verified
          ? { json: { next: "/volunteer/events?from=resend" } }
          : {
              status: 400,
              json: {
                code: errorCode,
                message:
                  errorCode === "OTP_EXPIRED" ? "OTP expired" : "Invalid OTP",
              },
            },
      );
    });
    await page.route(sendEndpoint, async (route) => {
      expect(route.request().postDataJSON()).toEqual({
        email: "link@example.org",
        type: "sign-in",
      });
      expect(new URL(route.request().url()).searchParams.get("returnTo")).toBe(
        "/volunteer",
      );
      await route.fulfill({ json: { success: true } });
    });
    const hash = new URLSearchParams({
      email: "link@example.org",
      otp: "123456",
      activation: crypto.randomUUID(),
      returnTo: "/volunteer/events?from=resend",
    });
    await page.goto(`/volunteer/sign-in/complete#${hash}`);
    await expect(page).toHaveURL(/\/volunteer\/sign-in\/complete$/);
    const code = page.locator("[data-email-code]");
    await expect(code).toBeVisible();
    await expect(code.locator('[name="email"]')).toHaveValue(
      "link@example.org",
    );
    await expect(code.locator("[data-form-message]")).toContainText(
      "Resend code",
    );
    await expect(
      page.getByRole("button", { name: "Try signing in again" }),
    ).toBeHidden();
    await expect(code.locator("[data-resend-code]")).toBeEnabled();
    await code.locator("[data-resend-code]").click();
    await chooseDelivery(page);
    await expect(code.locator("[data-resend-code]")).toHaveText(
      "Resend code (30s)",
    );
    verified = true;
    await code.locator('[name="code"]').fill("654321");
    await code.getByRole("button", { name: "Sign in with code" }).click();
    await expect(page).toHaveURL(/\/volunteer$/);
    expect(proofs).toEqual([
      { email: "link@example.org", otp: "123456" },
      { email: "link@example.org", otp: "654321" },
    ]);
  });
}

test("local email previews also work after resend, including wrong and valid code actions", async ({
  page,
}) => {
  await freezeClock(page);
  let sends = 0;
  await page.route(sendEndpoint, async (route) => {
    sends++;
    await route.fulfill({
      json: {
        success: true,
        localEmail: {
          email: "resend@example.org",
          code: sends === 1 ? "123456" : "654321",
          url: `${new URL(route.request().url()).origin}/volunteer/sign-in/complete#email=resend%40example.org&otp=654321`,
          id: `email-${sends}`,
        },
      },
    });
  });
  const proofs: object[] = [];
  await page.route(verifyEndpoint, async (route) => {
    proofs.push(route.request().postDataJSON());
    await route.fulfill(
      route.request().postDataJSON().otp === "654321"
        ? { json: { next: "/volunteer/events?from=resend" } }
        : {
            status: 400,
            json: { code: "INVALID_OTP", message: "Invalid OTP" },
          },
    );
  });
  await startSignIn(page);
  const dialog = page.getByRole("dialog", { name: "Local sign-in email" });
  await expect(dialog).toContainText("Your code is 123456");
  await dialog.getByRole("button", { name: "Simulate wrong code" }).click();
  await expect(
    page.locator("[data-email-code] [data-form-message]"),
  ).toContainText("already used");
  await page.clock.fastForward(30_000);
  await page.locator("[data-resend-code]").click();
  await chooseDelivery(page);
  await expect(dialog).toContainText("Your code is 654321");
  await expect(
    dialog.getByRole("link", { name: "Open local sign-in link" }),
  ).toBeVisible();
  await dialog.getByRole("button", { name: "Use valid code" }).click();
  await expect(page).toHaveURL(/\/volunteer$/);
  expect(proofs).toEqual([
    { email: "resend@example.org", otp: "000000" },
    { email: "resend@example.org", otp: "654321" },
  ]);
});

test("a consumed local-D1 link resends successfully after the real 30-second cooldown", async ({
  page,
  request,
  baseURL,
}) => {
  test.setTimeout(60_000);
  const email = `consumed-${crypto.randomUUID()}@example.org`;
  const delivered = await page.request.post(
    "/api/v1/auth/email-otp/send-verification-otp?returnTo=%2Fvolunteer%2Fevents",
    {
      headers: { origin: baseURL! },
      data: { email, type: "sign-in" },
    },
  );
  expect(delivered.status(), await delivered.text()).toBe(200);
  const deliveredAt = Date.now();
  const { localEmail } = await delivered.json();
  // A separate browser/client consumes the proof; this page remains signed out.
  const consumed = await request.post("/api/v1/auth/sign-in/email-otp", {
    headers: { origin: baseURL! },
    data: { email, otp: localEmail.code },
  });
  expect(consumed.status(), await consumed.text()).toBe(200);
  await page.goto(localEmail.url);
  const code = page.locator("[data-email-code]");
  await expect(code.locator("[data-form-message]")).toContainText(
    "already used",
  );
  await expect(code.locator('[name="email"]')).toHaveValue(email);
  const resend = code.locator("[data-resend-code]");
  await expect(resend).toBeEnabled();
  await resend.click();
  await chooseDelivery(page);
  await expect(code.locator("[data-form-message]")).toHaveText(
    "Wait 30 seconds before requesting another email.",
  );
  await expect(code.locator("[data-form-message]")).toHaveAttribute(
    "role",
    "alert",
  );
  await expect(resend).toBeEnabled();
  await expect(code.locator('[name="email"]')).toHaveValue(email);
  await expect(page).toHaveURL(/\/volunteer\/sign-in\/complete$/);
  // Browser clock mocks cannot advance the real Worker. Wait once, without
  // polling sends (which would spend the unchanged IP/hour budget).
  await new Promise((resolve) =>
    setTimeout(resolve, Math.max(0, deliveredAt + 30_000 - Date.now())),
  );
  await resend.click();
  await chooseDelivery(page);
  const preview = page.getByRole("dialog", { name: "Local sign-in email" });
  await expect(preview).toContainText(`To: ${email}`);
  await expect(preview).toContainText(
    "A new email replaces the previous code.",
  );
  await expect(resend).toBeDisabled();
  await preview.getByRole("button", { name: "Use valid code" }).click();
  await expect(page).toHaveURL(/\/volunteer$/);
});

test("a transient automatic link failure stays retryable and blocks resend during verification", async ({
  page,
}) => {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  let attempts = 0;
  await page.route(verifyEndpoint, async (route) => {
    attempts++;
    if (attempts === 1) await route.abort();
    else {
      await pending;
      await route.fulfill({ json: { twoFactorRedirect: true } });
    }
  });
  const hash = new URLSearchParams({
    email: "retry@example.org",
    otp: "123456",
    activation: crypto.randomUUID(),
    returnTo: "/volunteer/events",
  });
  await page.goto(`/volunteer/sign-in/complete#${hash}`);
  const confirm = page.getByRole("button", { name: "Try signing in again" });
  const code = page.locator("[data-email-code]");
  await expect(code.locator("[data-form-message]")).toHaveText(
    "We could not connect. Check your connection and try again.",
  );
  await expect(confirm).toBeVisible();
  await expect(confirm).toBeEnabled();
  await confirm.click();
  await expect.poll(() => attempts).toBe(2);
  const resend = code.locator("[data-resend-code]");
  await expect(resend).toBeDisabled();
  await resend.dispatchEvent("click");
  await code.dispatchEvent("submit");
  await page
    .getByRole("link", { name: "Use a different email" })
    .dispatchEvent("click");
  expect(attempts).toBe(2);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page).toHaveURL(/\/volunteer\/sign-in\/complete$/);
  release();
  await expect(page.locator("[data-second-factor]")).toBeVisible();
  await expect(code).toBeHidden();
  await expect(page.locator("[data-email-link]")).toBeHidden();
});

test("incomplete links recover with their email when available and sanitize the reset destination", async ({
  page,
}) => {
  const hash = new URLSearchParams({
    email: "incomplete@example.org",
    otp: "123",
    returnTo: "https://example.org",
  });
  await page.goto(`/volunteer/sign-in/complete#${hash}`);
  const code = page.locator("[data-email-code]");
  await expect(code).toBeVisible();
  await expect(code.locator('[name="email"]')).toHaveValue(
    "incomplete@example.org",
  );
  await expect(code.locator("[data-resend-code]")).toBeEnabled();
  await expect(code).toHaveAttribute("data-return-to", "/volunteer");
  await page.getByRole("link", { name: "Use a different email" }).click();
  await expect(page).toHaveURL(/\/volunteer\/sign-in\?returnTo=%2Fvolunteer$/);
  await expect(
    page.getByRole("textbox", { name: "Email", exact: true }),
  ).toHaveValue("");
  await page.goto(
    "/volunteer/sign-in/complete#otp=123456&returnTo=%2Fvolunteer%2Fevents",
  );
  await expect(
    page.locator("[data-email-link] [data-form-message]"),
  ).toContainText("incomplete");
  await expect(code).toBeHidden();
  await expect(
    page.getByRole("button", { name: "Try signing in again" }),
  ).toBeHidden();
  await expect(
    page.getByRole("link", { name: "Request a new email" }),
  ).toHaveAttribute("href", "/volunteer/sign-in?returnTo=%2Fvolunteer");
  await expect(page).toHaveURL(/\/volunteer\/sign-in\/complete$/);
});
