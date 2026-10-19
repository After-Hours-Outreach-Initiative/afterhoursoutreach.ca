import { expect, test } from "@playwright/test";
import {
  createLocalAccount,
  fillApplicationField,
  openLocalAccountSwitcher,
  sampleAnswers,
  submitLocalApplication,
} from "../helpers/local-account";

test.beforeEach(async ({ page, baseURL }) => {
  test.skip(
    !baseURL?.startsWith("http://localhost:"),
    "Requires local D1 development",
  );
  // Keep persistent D1 rate limits real, but isolate each browser test from
  // previous test runs and the developer's own localhost sign-in requests.
  const ip = crypto.getRandomValues(new Uint8Array(2));
  await page.setExtraHTTPHeaders({
    "cf-connecting-ip": `198.18.${ip[0]}.${ip[1]}`,
  });
  await page.goto("/volunteer/sign-in");
  await expect(
    page.getByRole("button", { name: "Continue with Email" }),
  ).toBeVisible();
});

test("Not applied always starts blank; submitted local accounts persist and can be deleted", async ({
  page,
  baseURL,
}) => {
  const current = async () =>
    (await (await page.request.get("/api/v1/auth/get-session")).json()).user;
  const draft = async () =>
    await (await page.request.get("/api/v1/account/application-draft")).json();
  const disposableUsers = async () => {
    const { users }: { users: { id: string }[] } = await (
      await page.request.get("/api/v1/auth/dev/users")
    ).json();
    // Other browser tests may create ordinary accounts in the shared test D1.
    return users.filter(({ id }) => id.startsWith("local-application-"));
  };
  const choose = async (id: string) => {
    const profiles = await openLocalAccountSwitcher(page);
    await Promise.all([
      page.waitForEvent("domcontentloaded"),
      profiles.locator(`[data-switch-user="${id}"]`).click(),
    ]);
  };
  const expectBlank = async () => {
    await expect(page).toHaveURL(/\/apply$/);
    await expect(page.locator('[name="firstName"]')).toHaveValue("");
    await expect(
      page.locator("form[data-application] input:checked"),
    ).toHaveCount(0);
    expect(await draft()).toMatchObject({ submitted: false, draft: null });
  };

  await choose("new-application");
  await expectBlank();
  const first = await current();
  await page.locator('[name="firstName"]').fill("Unfinished draft");
  await page.locator('[name="teams"][value="outreach"]').check();
  await page.locator('[name="teams"][value="medic"]').check();
  await expect
    .poll(async () => (await draft()).draft?.answers.teams)
    .toEqual(["outreach", "medic"]);

  // Invalid submission neither creates a completed account nor consumes the persona.
  const before = await disposableUsers();
  const invalid = await page.request.post("/api/v1/account/profile", {
    headers: { origin: baseURL! },
    data: { ...sampleAnswers, teams: [], codeOfConductAccepted: true },
  });
  expect(invalid.status()).toBe(400);
  expect(await draft()).toMatchObject({
    submitted: false,
    draft: { answers: { firstName: "Unfinished draft" } },
  });
  expect(await disposableUsers()).toEqual(before);

  await choose("new-application");
  await expectBlank();
  const second = await current();
  expect(second.id).not.toBe(first.id);
  // The abandoned draft remains explicitly selectable/deletable, never invisible.
  await choose(first.id);
  await expect(page.locator('[name="firstName"]')).toHaveValue(
    "Unfinished draft",
  );
  await expect(page.locator('[name="teams"][value="medic"]')).toBeChecked();
  await choose(second.id);
  await expectBlank();
  for (const key of [
    "firstName",
    "lastName",
    "preferredName",
    "phone",
    "birthDate",
    "emergencyName",
    "emergencyPhone",
    "emergencyRelationship",
    "motivation",
  ] as const)
    await fillApplicationField(page, key, sampleAnswers[key]);
  for (const [name, value] of [
    ["teams", "outreach"],
    ["training", "none"],
    ["heardAboutUsSources", "friend-word-of-mouth"],
  ])
    await page.locator(`[name="${name}"][value="${value}"]`).check();
  await submitLocalApplication(page);
  await expect(page).toHaveURL(/\/volunteer\/account$/);
  expect(await current()).toMatchObject({
    id: second.id,
    name: sampleAnswers.preferredName,
  });
  await page.reload();
  expect(await draft()).toMatchObject({ submitted: true, draft: null });
  const profiles = await openLocalAccountSwitcher(page);
  await expect(
    profiles.locator(`[data-switch-user="${second.id}"]`),
  ).toContainText(sampleAnswers.preferredName);
  await expect(
    profiles.locator(`[data-switch-user="${second.id}"]`),
  ).toHaveAttribute("aria-pressed", "true");
  await page
    .getByRole("button", { name: "Close development controls" })
    .click();

  await choose("new-application");
  await expectBlank();
  const third = await current();
  const choices = await openLocalAccountSwitcher(page);
  const remove = choices.locator(`[data-delete-user="${second.id}"]`);
  page.once("dialog", (dialog) => dialog.dismiss());
  await remove.click();
  await expect(remove).toBeVisible();
  page.once("dialog", (dialog) => dialog.accept());
  await remove.click();
  await expect(remove).toHaveCount(0);
  expect((await current()).id).toBe(third.id);
  // Deleting the current account revokes its session and returns to Visitor.
  page.once("dialog", (dialog) => dialog.accept());
  await choices.locator(`[data-delete-user="${third.id}"]`).click();
  await expect(page).toHaveURL(/\/volunteer$/);
  expect(
    await (await page.request.get("/api/v1/auth/get-session")).json(),
  ).toBeNull();
  const remaining = await openLocalAccountSwitcher(page);
  for (const id of [second.id, third.id])
    await expect(remaining.locator(`[data-switch-user="${id}"]`)).toHaveCount(
      0,
    );
  await expect(
    remaining.locator(`[data-delete-user="${first.id}"]`),
  ).toBeVisible();
  await expect(
    remaining.locator('[data-switch-user="new-application"]'),
  ).toBeEnabled();
});

test("unfinished application shows a clickable yellow warning card without clipping", async ({
  page,
  baseURL,
}) => {
  await page.goto("/volunteer");
  const warning = page.getByRole("link", {
    name: "Please complete your Volunteer Application",
    exact: true,
  });
  await expect(warning).toHaveCount(0);
  await createLocalAccount(page.request, baseURL!, false);
  await page.goto("/volunteer");
  await expect(warning).toBeVisible();
  await expect(warning).toHaveClass(/volunteer-application-warning/);
  await expect(warning).toHaveAttribute("href", "/apply");
  await expect(warning).toHaveText(
    "Please complete your Volunteer Application",
  );
  await expect(warning).toHaveCSS("background-color", "rgb(33, 26, 8)");
  await expect(warning).toHaveCSS("border-top-color", "rgb(161, 98, 7)");
  const icon = warning.locator("svg.volunteer-warning-icon");
  await expect(icon).toBeVisible();
  await expect(icon).toHaveAttribute("aria-hidden", "true");
  await expect(icon).toHaveCSS("color", "rgb(250, 204, 21)");
  const arrow = warning.locator("svg.volunteer-application-warning-arrow");
  await expect(arrow).toBeVisible();
  await expect(arrow).toHaveAttribute("aria-hidden", "true");
  const text = warning.locator(".volunteer-application-warning-text");
  expect(
    await text.evaluate(
      (element) =>
        element.getBoundingClientRect().height <=
        Number.parseFloat(getComputedStyle(element).lineHeight) + 1,
    ),
  ).toBe(true);
  for (const width of [375, 320]) {
    await page.setViewportSize({ width, height: 812 });
    await expect(text).toHaveCSS("white-space", "normal");
    expect(
      await text.evaluate(
        (element) => element.scrollWidth <= element.clientWidth,
      ),
    ).toBe(true);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
    ).toBe(false);
  }
  await warning.focus();
  await warning.press("Enter");
  await expect(page).toHaveURL(/\/apply$/);
  await page.goto("/volunteer");
  // The padding is clickable too, not just the text or arrow.
  await warning.click({ position: { x: 4, y: 4 } });
  await expect(page).toHaveURL(/\/apply$/);
  const application = await page.request.post("/api/v1/account/profile", {
    headers: { origin: baseURL! },
    data: { ...sampleAnswers, codeOfConductAccepted: true },
  });
  expect(application.status(), await application.text()).toBe(200);
  await page.goto("/volunteer");
  await expect(warning).toHaveCount(0);
});

test("local D1 sign-in uses dialogs for delivery, errors and valid codes", async ({
  page,
}) => {
  const requests: string[] = [];
  page.on("request", (request) => {
    if (
      new URL(request.url()).pathname ===
      "/api/v1/auth/email-otp/send-verification-otp"
    )
      requests.push(request.url());
  });
  await page
    .getByRole("textbox", { name: "Email", exact: true })
    .fill(`local-code-${crypto.randomUUID()}@example.org`);
  for (const outcome of ["Simulate delivery failure", "Simulate rate limit"]) {
    await page.getByRole("button", { name: "Continue with Email" }).click();
    await page.getByRole("button", { name: outcome }).click();
    await expect(
      page.locator("[data-email-request] [data-form-message]"),
    ).toContainText("Simulated locally");
  }
  expect(requests).toEqual([]);
  await page.getByRole("button", { name: "Continue with Email" }).click();
  await page
    .getByRole("button", { name: "Simulate successful delivery" })
    .click();
  const dialog = page.getByRole("dialog", { name: "Local sign-in email" });
  await expect(dialog).toBeVisible();
  const code = (await dialog.innerText()).match(/Your code is (\d{6})/)![1];
  await dialog.getByRole("button", { name: "Simulate wrong code" }).click();
  await expect(
    page.locator("[data-email-code] [data-form-message]"),
  ).toContainText("Invalid");
  await page.getByLabel("Six-digit code").fill(code);
  await page.getByRole("button", { name: "Sign in with code" }).click();
  await expect(page).toHaveURL(/\/apply/);
  await expect(
    page.getByRole("navigation", { name: "Volunteer account" }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("heading", {
      name: "Volunteer Application",
      level: 2,
      exact: true,
    }),
  ).toBeVisible();
});

test("local D1 email links are one-use and sign-in pages have no third-party requests", async ({
  page,
  request,
}) => {
  const external: string[] = [];
  page.on("request", (req) => {
    if (new URL(req.url()).hostname !== "localhost") external.push(req.url());
  });
  await page.reload();
  await page
    .getByRole("textbox", { name: "Email", exact: true })
    .fill(`local-link-${crypto.randomUUID()}@example.org`);
  await page.getByRole("button", { name: "Continue with Email" }).click();
  await page
    .getByRole("button", { name: "Simulate successful delivery" })
    .click();
  const link = page.getByRole("link", { name: "Open local sign-in link" });
  const url = new URL((await link.getAttribute("href"))!);
  const proof = Object.fromEntries(new URLSearchParams(url.hash.slice(1)));
  // A scanner can load every resource and execute JS, but has no requesting-
  // browser cookie. Its activation must leave the real link usable.
  const scanner = await page.context().browser()!.newContext();
  try {
    const scanned = await scanner.newPage();
    const activation = scanned.waitForResponse((response) =>
      response.url().includes("/api/v1/auth/sign-in/email-otp"),
    );
    await scanned.goto(url.href);
    expect((await activation).status()).toBe(403);
    await expect(scanned.locator("[data-email-code]")).toBeVisible();
    await expect(scanned.getByLabel("Six-digit code")).toHaveValue("");
    await expect(scanned.locator("[data-form-message]:visible")).toContainText(
      "browser where you requested it",
    );
  } finally {
    await scanner.close();
  }
  await link.click();
  await expect(page).toHaveURL(/\/apply/);
  expect(new URL(page.url()).hash).toBe("");
  const replay = await request.post("/api/v1/auth/sign-in/email-otp", {
    headers: { origin: url.origin },
    data: { email: proof.email, otp: proof.otp },
  });
  expect(replay.status()).toBe(400);
  expect(external).toEqual([]);
});
