import { expect, test } from "@playwright/test";
import {
  createLocalAccount,
  openLocalAccountSwitcher,
  sampleAnswers,
} from "../helpers/local-account";
import { totpFromSetupKey } from "../helpers/totp";

test.beforeEach(async ({ page, baseURL }) => {
  test.skip(
    !baseURL?.startsWith("http://localhost:"),
    "Local D1 development only",
  );
  await page.goto("/volunteer");
});

for (const width of [1280, 375, 320]) {
  test(`signed-out volunteer page hides events and keeps sign-in below navigation at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 812 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    const expectCardBelowNavigation = async () => {
      await expect
        .poll(async () => {
          const [card, header] = await Promise.all([
            page.locator("#volunteer-signin").boundingBox(),
            page.locator("header").boundingBox(),
          ]);
          if (!card || !header) return -1;
          return card.y - (header.y + header.height);
        })
        .toBeGreaterThanOrEqual(16);
    };
    await expect(
      page.locator("[data-live-event], [data-event-list]"),
    ).toHaveCount(0);
    await expectCardBelowNavigation();

    await page.reload();
    await expectCardBelowNavigation();
  });
}

test("volunteer-page sign-in is usable on mobile and opens the shared code form", async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 812 });
  const emails: string[] = [];
  await page.route(
    "**/api/v1/auth/email-otp/send-verification-otp**",
    (route) => {
      emails.push(route.request().postDataJSON().email);
      return route.fulfill({ json: { success: true } });
    },
  );
  await page
    .getByRole("textbox", { name: "Email", exact: true })
    .fill("mobile@example.org");
  await page.getByRole("button", { name: "Continue with Email" }).click();
  await page
    .getByRole("button", { name: "Simulate successful delivery" })
    .click();
  await expect(page.getByLabel("Six-digit code")).toBeVisible();
  await expect(page.getByLabel("Six-digit code")).toBeFocused();
  expect(emails).toEqual(["mobile@example.org"]);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
  ).toBe(false);
});

test("event type buttons filter instantly, preserve deep links, and never submit a confirmation form", async ({
  page,
}) => {
  await (
    await openLocalAccountSwitcher(page)
  )
    .locator('[data-switch-user="local-fixture-user-casey"]')
    .click();
  await expect(page.locator("[data-event-list]")).toBeVisible();
  const documents: string[] = [];
  page.on("request", (request) => {
    if (request.resourceType() === "document") documents.push(request.url());
  });
  const cards = page.locator("[data-live-event]");
  const types = await cards.evaluateAll((nodes) =>
    nodes.map((node) => (node as HTMLElement).dataset.eventType),
  );
  // Polling may add events from another test/viewer while this filter is active.
  // Verify every current card's visibility, not a stale initial list length.
  const expectFilter = (type: string) =>
    expect
      .poll(() =>
        cards.evaluateAll(
          (nodes, selected) =>
            nodes.every((node) => {
              const card = node as HTMLElement;
              return (
                card.hidden ===
                (selected !== "all" && card.dataset.eventType !== selected)
              );
            }),
          type,
        ),
      )
      .toBe(true);
  const filters = page.getByRole("group", { name: "Filter events" });
  expect(types).toContain("orientation");
  expect(types).toContain("patrol");
  await filters
    .getByRole("button", { name: "Orientations", exact: true })
    .click();
  await expect(
    filters.getByRole("button", { name: "Orientations", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expectFilter("orientation");
  await expect(page).toHaveURL(/\?type=orientation$/);
  await filters.getByRole("button", { name: "Patrols", exact: true }).click();
  await expectFilter("patrol");
  await page.goBack();
  await expect(
    filters.getByRole("button", { name: "Orientations", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expectFilter("orientation");
  expect(documents).toEqual([]);
  await page.reload();
  await expectFilter("orientation");
  await filters
    .getByRole("button", { name: "All events", exact: true })
    .click();
  await expectFilter("all");
});

test("View as has a button for every seeded profile and supports keyboard switching on mobile", async ({
  page,
}) => {
  for (const width of [1280, 375, 320]) {
    await page.setViewportSize({ width, height: 812 });
    const profiles = await openLocalAccountSwitcher(page);
    await expect(profiles.getByRole("combobox")).toHaveCount(0);
    for (const key of [
      "alex",
      "casey",
      "dana",
      "jamie",
      "robin",
      "sam",
      "first-sign-in",
    ]) {
      const profile = profiles.locator(
        `[data-switch-user="local-fixture-user-${key}"]`,
      );
      await expect(profile).toBeVisible();
      await expect(profile).toBeEnabled();
      await expect(profile).toContainText(`${key}.local@example.org`);
    }
    await expect(
      profiles.getByRole("button", { name: "Visitor", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
    ).toBe(false);
    await page
      .getByRole("button", { name: "Close development controls", exact: true })
      .click();
  }
  const profiles = await openLocalAccountSwitcher(page);
  const robin = profiles.locator(
    '[data-switch-user="local-fixture-user-robin"]',
  );
  await robin.focus();
  await robin.press("Enter");
  await page
    .getByRole("button", { name: "Open navigation", exact: true })
    .click();
  await expect(
    page
      .getByRole("navigation", { name: "Mobile navigation" })
      .getByRole("link", { name: "Volunteers", exact: true }),
  ).toBeVisible();
  await expect(robin).toHaveAttribute("aria-pressed", "true");
});

test("profile buttons disable during switching and recover without changing selection on failure", async ({
  page,
}) => {
  const profiles = await openLocalAccountSwitcher(page);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  await page.route("**/api/v1/auth/dev/switch-user", async (route) => {
    await gate;
    await route.fulfill({
      status: 503,
      json: { message: "Try switching again." },
    });
  });
  const robin = profiles.locator(
    '[data-switch-user="local-fixture-user-robin"]',
  );
  const visitor = profiles.getByRole("button", {
    name: "Visitor",
    exact: true,
  });
  try {
    await robin.click();
    await expect(profiles).toHaveAttribute("aria-busy", "true");
    await expect(robin).toBeDisabled();
    await expect(visitor).toBeDisabled();
  } finally {
    release();
  }
  await expect(page.locator("[data-switch-message]")).toHaveText(
    "Try switching again.",
  );
  await expect(profiles).toHaveAttribute("aria-busy", "false");
  await expect(robin).toBeEnabled();
  await expect(visitor).toBeEnabled();
  await expect(visitor).toHaveAttribute("aria-pressed", "true");
  await expect(robin).toHaveAttribute("aria-pressed", "false");
});

test("View as lists actual D1 users and switching to Visitor ends only the current session", async ({
  page,
  request,
  baseURL,
}) => {
  const user = await createLocalAccount(request, baseURL!);
  const independent = await request.get("/api/v1/auth/get-session");
  const independentSession: { session: { id: string } } =
    await independent.json();
  await page.reload();
  const profiles = await openLocalAccountSwitcher(page);
  const profile = profiles.locator(`[data-switch-user="${user.id}"]`);
  await expect(profile).toContainText(user.email);
  await expect(page.locator("[data-account-menu]")).toHaveCount(0);
  await profile.click();
  await expect(page.locator("[data-account-menu]")).toBeVisible();
  await expect(profile).toHaveAttribute("aria-pressed", "true");
  const selected = await page.request.get("/api/v1/auth/get-session");
  const selectedSession: { user: { id: string }; session: { id: string } } =
    await selected.json();
  expect(selectedSession.user.id).toBe(user.id);
  expect(selectedSession.session.id).not.toBe(independentSession.session.id);
  await (
    await openLocalAccountSwitcher(page)
  )
    .getByRole("button", { name: "Visitor", exact: true })
    .click();
  await expect(page).toHaveURL(/\/volunteer\/?$/);
  await expect(page.locator("[data-account-menu]")).toHaveCount(0);
  expect(
    await (await page.request.get("/api/v1/auth/get-session")).json(),
  ).toBeNull();
  expect(
    (await (await request.get("/api/v1/auth/get-session")).json()).session.id,
  ).toBe(independentSession.session.id);
});

test("View as can choose a D1 account without an application without changing it", async ({
  page,
  request,
  baseURL,
}) => {
  const user = await createLocalAccount(request, baseURL!, false);
  await page.reload();
  const profiles = await openLocalAccountSwitcher(page);
  const profile = profiles.locator(`[data-switch-user="${user.id}"]`);
  await profile.click();
  await expect(page).toHaveURL(/\/apply$/);
  await expect(
    page.getByRole("heading", {
      name: "Volunteer Application",
      level: 2,
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.getByRole("textbox", { name: /^Email/ })).toHaveValue(
    user.email,
  );
  await expect(page.getByLabel("First name")).toHaveValue("");
  await expect(profile).toHaveAttribute("aria-pressed", "true");
});

test("account navigation and profile controls are usable on desktop and mobile", async ({
  page,
  baseURL,
}) => {
  const user = await createLocalAccount(page.request, baseURL!);
  await page.reload();
  for (const width of [1280, 375, 320]) {
    await page.setViewportSize({ width, height: 812 });
    const menu = page.locator(
      width < 1024 ? "[data-mobile-account]" : "[data-account-menu]",
    );
    if (width < 1024) {
      await page
        .getByRole("button", { name: "Open navigation", exact: true })
        .click();
      await expect(menu.locator("[data-account-menu-name]")).toHaveText(
        user.name,
      );
    } else {
      await expect(menu.locator("summary")).toHaveAccessibleName(
        `Account for ${user.name}`,
      );
      await menu.locator("summary").click();
    }
    await expect(menu).toContainText(user.email);
    await menu.getByRole("link", { name: "Account", exact: true }).click();
    await expect(page).toHaveURL(/\/volunteer\/account$/);
    await expect(
      page.getByRole("heading", { name: "Your account", exact: true }),
    ).toBeVisible();
    const form = page.locator("[data-account-profile]");
    await expect(form.getByRole("heading", { level: 3 })).toHaveText([
      "Personal info",
      "Emergency contact",
      "Team interests",
      "Training and safety",
    ]);
    await expect(
      form.getByRole("group", { name: "About volunteering", exact: true }),
    ).toHaveCount(0);
    const name = page.getByLabel("First name");
    await expect(name).toHaveValue(sampleAnswers.firstName);
    await expect(name).toBeEditable();
    const emergencyContact = page.getByRole("group", {
      name: "Emergency contact",
      exact: true,
    });
    await expect(emergencyContact).toBeVisible();
    await expect(emergencyContact.locator("input")).toHaveCount(3);
    for (const field of [
      "emergencyName",
      "emergencyPhone",
      "emergencyRelationship",
    ] as const)
      await expect(
        emergencyContact.locator(`input[name="${field}"]`),
      ).toHaveValue(sampleAnswers[field]);
    await expect(emergencyContact).toHaveCSS("border-top-width", "0px");
    await expect(emergencyContact).toHaveCSS("padding", "0px");
    for (const heading of await form.getByRole("heading", { level: 3 }).all()) {
      await expect(heading).toHaveCSS("font-size", "22px");
      await expect(heading).toHaveCSS("border-bottom-width", "1px");
    }
    expect(
      await emergencyContact
        .locator(".volunteer-fields")
        .evaluate(
          (element) =>
            getComputedStyle(element).gridTemplateColumns.split(" ").length,
        ),
    ).toBe(width <= 640 ? 1 : 2);
    expect(
      await form
        .locator(".volunteer-team-options")
        .evaluate(
          (element) =>
            getComputedStyle(element).gridTemplateColumns.split(" ").length,
        ),
    ).toBe(width <= 640 ? 1 : 3);
    const medic = form.getByLabel("Medic", { exact: true });
    await medic.check();
    const certifications = form.locator("[data-medic-certifications]");
    await expect(certifications).toBeVisible();
    expect(
      await certifications
        .locator(".volunteer-certification-options")
        .evaluate(
          (element) =>
            getComputedStyle(element).gridTemplateColumns.split(" ").length,
        ),
    ).toBe(1);
    const certificationOptions = certifications.locator(
      ".volunteer-certification-options > label",
    );
    await expect(certificationOptions).toHaveCount(6);
    for (const option of await certificationOptions.all()) {
      await expect(option).toHaveCSS("align-items", "flex-start");
      await expect(option).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
      await expect(option).toHaveCSS("padding", "0px");
      await expect(option).toHaveCSS("border-top-width", "0px");
    }
    await certifications
      .getByText(
        "Respiratory Therapist (RT) / Nurse Practitioner (NP) / Physician",
        { exact: true },
      )
      .click();
    const practitioner = certifications.getByRole("radio", {
      name: "Respiratory Therapist (RT) / Nurse Practitioner (NP) / Physician",
      exact: true,
    });
    await expect(practitioner).toBeChecked();
    await certifications
      .getByRole("radio", { name: "Other", exact: true })
      .check();
    const otherTraining = certifications.locator(
      'label:has([value="other"]) + [data-other-training]',
    );
    await expect(otherTraining).toBeVisible();
    await expect(otherTraining.locator("label")).toHaveClass("sr-only");
    await expect(otherTraining.locator("label")).toHaveCSS(
      "position",
      "absolute",
    );
    await expect(otherTraining.locator(".volunteer-help")).toHaveCount(0);
    await expect(
      otherTraining.getByRole("textbox", {
        name: "Other training and experience",
        exact: true,
      }),
    ).toBeEditable();
    expect(
      await form.evaluate((element) => {
        const other = element
          .querySelector('[name="certifications"][value="other"]')!
          .closest("label")!;
        const details = element.querySelector("[data-other-training]")!;
        const expiry = element.querySelector("[data-certification-expiry]")!;
        return (
          details.getBoundingClientRect().top >=
            other.getBoundingClientRect().bottom &&
          expiry.getBoundingClientRect().top >=
            details.getBoundingClientRect().bottom
        );
      }),
    ).toBe(true);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
    ).toBe(false);
    await form.evaluate((element: HTMLFormElement) => element.reset());
    const save = page.getByRole("button", { name: "Save profile" });
    await expect(save).toBeDisabled();
    await name.fill("Unsaved layout draft");
    await expect(save).toBeEnabled();
    await name.fill(sampleAnswers.firstName);
    await expect(save).toBeDisabled();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
    ).toBe(false);
    if (width < 1024)
      await page
        .getByRole("button", { name: "Open navigation", exact: true })
        .click();
    await page
      .getByRole("navigation", {
        name: width < 1024 ? "Mobile navigation" : "Primary navigation",
      })
      .getByRole("link", { name: "Volunteer", exact: true })
      .click();
    await expect(page).toHaveURL(/\/volunteer\/?$/);
  }
  await page
    .getByRole("button", { name: "Open navigation", exact: true })
    .click();
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(page).toHaveURL(/\/volunteer\/sign-in$/);
  expect(
    await (await page.request.get("/api/v1/auth/get-session")).json(),
  ).toBeNull();
});

test("local account selection rejects cross-origin writes and unknown users", async ({
  page,
  request,
  baseURL,
}) => {
  const user = await createLocalAccount(request, baseURL!);
  const response = await request.post("/api/v1/auth/dev/switch-user", {
    headers: { origin: "https://evil.example" },
    data: { userId: user.id },
  });
  expect(response.status()).toBe(403);
  const missingOrigin = await request.post("/api/v1/auth/dev/switch-user", {
    data: { userId: user.id },
  });
  expect(missingOrigin.status()).toBe(403);
  const crossSite = await request.get("/api/v1/auth/dev/users", {
    headers: { origin: "https://evil.example" },
  });
  expect(crossSite.status()).toBe(403);
  const unknown = await request.post("/api/v1/auth/dev/switch-user", {
    headers: { origin: baseURL! },
    data: { userId: "not-a-user" },
  });
  expect(unknown.status()).toBe(404);
  expect(
    (await (await request.get("/api/v1/auth/get-session")).json()).user.id,
  ).toBe(user.id);
  await page.reload();
  await openLocalAccountSwitcher(page);
});

test("View as simulates a verified factor without changing the user's real role or enrollment", async ({
  page,
  request,
  baseURL,
}) => {
  const user = await createLocalAccount(request, baseURL!);
  const enabled = await request.post("/api/v1/auth/two-factor/enable", {
    headers: { origin: baseURL! },
    data: { method: "totp" },
  });
  expect(enabled.status()).toBe(200);
  const setup: { totpURI: string } = await enabled.json();
  const verified = await request.post("/api/v1/auth/two-factor/verify-totp", {
    headers: { origin: baseURL! },
    data: {
      code: totpFromSetupKey(
        new URL(setup.totpURI).searchParams.get("secret")!,
      ),
    },
  });
  expect(verified.status()).toBe(200);
  await page.reload();
  const profiles = await openLocalAccountSwitcher(page);
  const profile = profiles.locator(`[data-switch-user="${user.id}"]`);
  await profile.click();
  await expect(page.locator("[data-account-menu]")).toBeVisible();
  await expect(profile).toHaveAttribute("aria-pressed", "true");
  const current = await page.request.get("/api/v1/auth/get-session");
  const session = await current.json();
  expect(session.user.id).toBe(user.id);
  expect(session.user.role).toBe("volunteer");
  expect(session.user.twoFactorEnabled).toBe(true);
  expect(session.session.twoFactorVerified).toBe(true);
  await expect(page.locator("[data-volunteer-menu]")).toBeHidden();
});
