import { expect, test } from "@playwright/test";
import { profileWriteBody } from "../helpers/profile-write";
import { social } from "../../src/data/site";
import {
  accountStatePersona,
  manualAccountPresets,
} from "../../src/dev/accounts";
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

test("Alt+Z toggles the DEV panel and restores focus without changing form input", async ({
  page,
}) => {
  const trigger = page.getByRole("button", { name: "DEV panel", exact: true });
  const panel = page.getByRole("dialog", { name: "DEV panel", exact: true });
  const email = page.getByRole("textbox", { name: "Email", exact: true });
  await expect(trigger).toHaveAttribute("aria-keyshortcuts", "Alt+Z");
  await email.fill("dev-panel@example.org");
  await page.keyboard.press("Alt+KeyZ");
  await expect(panel).toBeVisible();
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
  await page.keyboard.press("Alt+KeyZ");
  await expect(panel).toBeHidden();
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  await expect(email).toBeFocused();
  await expect(email).toHaveValue("dev-panel@example.org");

  await trigger.click();
  await expect(panel).toBeVisible();
  await page.keyboard.press("Alt+KeyZ");
  await expect(panel).toBeHidden();
  await expect(trigger).toBeFocused();
});

test("DEV panel separates states from saved accounts and completes each application step", async ({
  page,
  baseURL,
}) => {
  const endpoint = "/api/v1/auth/dev/application-step";
  const post = (userId: string, step: string, origin = baseURL!) =>
    page.request.post(endpoint, {
      headers: { origin },
      data: { userId, step },
    });
  expect((await post("visitor", "form")).status()).toBe(401);
  const profiles = await openLocalAccountSwitcher(page);
  const states = profiles.getByRole("group", {
    name: "Account states",
    exact: true,
  });
  const accounts = profiles.getByRole("group", {
    name: "Existing accounts",
    exact: true,
  });
  await expect(
    states.locator('[data-switch-user="new-application"]'),
  ).toBeVisible();
  await expect(
    accounts.locator('[data-switch-user="local-fixture-user-robin"]'),
  ).toBeVisible();
  await expect(
    states.locator('[data-switch-user^="local-fixture-user-"]'),
  ).toHaveCount(0);
  await expect(
    profiles.locator('[data-application-step="form"]'),
  ).toBeDisabled();
  await states.locator('[data-switch-user="new-application"]').click();
  await expect(page).toHaveURL(/\/apply$/);
  const { user } = await (
    await page.request.get("/api/v1/auth/get-session")
  ).json();
  expect(
    (await post(user.id, "form", "https://unrelated.example.org")).status(),
  ).toBe(403);
  expect((await post("another-account", "form")).status()).toBe(409);

  for (const [index, step] of [
    "form",
    "naloxone",
    "discord",
    "review",
  ].entries()) {
    const panel = await openLocalAccountSwitcher(page);
    const button = panel.locator(`[data-application-step="${step}"]`);
    await expect(button).toBeEnabled();
    if (index === 0)
      await expect(
        panel.locator('[data-application-step="naloxone"]'),
      ).toBeDisabled();
    if (index < 3)
      await expect(
        panel.locator('[data-application-step="review"]'),
      ).toBeDisabled();
    await button.click();
    await expect(page).toHaveURL(/\/volunteer$/);
    if (index === 0) {
      const tracker = page.locator("[data-application-tracker]");
      const portal = page.locator("[data-event-browser]");
      const invite = portal.getByRole("link", {
        name: "Join Discord",
        exact: true,
      });
      await expect(portal).toContainText(
        "Join our Discord for the most up to date information.",
      );
      await expect(invite).toHaveAttribute("href", social.discord);
      await expect(invite).toHaveAttribute("target", "_blank");
      await expect(invite).toHaveAttribute("rel", "noreferrer");
      await expect(
        portal.getByRole("link", {
          name: "Manage Discord connection",
          exact: true,
        }),
      ).toHaveCount(0);
      await expect(
        tracker.locator("[data-application-progress-step]"),
      ).toHaveCount(4);
      await expect(
        tracker.locator('[data-application-progress-step="discord"]'),
      ).toHaveAttribute("data-state", "upcoming");
    }
    if (index === 1)
      await expect(
        page.locator('[data-application-progress-step="discord"]'),
      ).toHaveAttribute("data-state", "current");
    if (index < 2)
      await expect(
        page
          .locator('[data-application-progress-step="review"]')
          .getByText("Pending approval", { exact: true }),
      ).toHaveCount(0);
    if (index === 2) {
      await expect(
        page.locator('[data-application-progress-step="review"]'),
      ).toHaveAttribute("data-state", "current");
      await expect(
        page
          .locator('[data-application-progress-step="review"]')
          .getByText("Pending approval", { exact: true }),
      ).toBeVisible();
    }
    const refreshed = await openLocalAccountSwitcher(page);
    await expect(
      refreshed.locator(`[data-application-step="${step}"]`),
    ).toBeDisabled();
    await expect(
      refreshed.locator(`[data-application-step="${step}"] [data-step-status]`),
    ).toHaveText("Completed");
    await page.keyboard.press("Alt+KeyZ");
  }
  await expect(page.locator("[data-event-list]")).toBeVisible();
});

test("DEV panel seeds presets in place without changing the current account or duplicating users", async ({
  page,
  request,
  baseURL,
}) => {
  const endpoint = "/api/v1/auth/dev/seed-accounts";
  expect(
    (
      await page.request.post(endpoint, {
        headers: { origin: "https://unrelated.example.org" },
        data: {},
      })
    ).status(),
  ).toBe(403);
  const profiles = await openLocalAccountSwitcher(page);
  await profiles.locator('[data-switch-user="new-application"]').click();
  await expect(page).toHaveURL(/\/apply$/);
  const original = await (
    await page.request.get("/api/v1/auth/get-session")
  ).json();
  await page.locator('[name="firstName"]').fill("Keep my draft");
  await openLocalAccountSwitcher(page);
  const seed = page.getByRole("button", {
    name: "Seed local accounts",
    exact: true,
  });
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = page.waitForResponse((response) =>
      response.url().endsWith(endpoint),
    );
    await seed.click();
    expect(await (await response).headerValue("set-cookie")).toBeNull();
    await expect(page.locator("[data-switch-message]")).toContainText(
      "Existing records and edits were preserved",
    );
    await expect(profiles).toHaveAttribute("aria-busy", "false");
    await expect(
      profiles.locator('[data-switch-user^="local-account-user-"]'),
    ).toHaveCount(manualAccountPresets.length);
    await expect(seed).toBeEnabled();
  }
  const current = await (
    await page.request.get("/api/v1/auth/get-session")
  ).json();
  expect(current.user.id).toBe(original.user.id);
  expect(current.session.id).toBe(original.session.id);
  await expect(page).toHaveURL(/\/apply$/);
  await expect(page.locator('[name="firstName"]')).toHaveValue("Keep my draft");
  const categories = profiles.locator("[data-account-category]");
  await expect(categories).toHaveCount(4);
  await expect(profiles.locator("details[data-account-category]")).toHaveCount(
    0,
  );
  for (const preset of manualAccountPresets)
    await expect(
      profiles.locator(`[data-switch-user="${preset.id}"]`),
    ).toBeVisible();
  for (const [key, count] of [
    ["application", 4],
    ["orientation", 4],
    ["volunteers", 2],
    ["access", 2],
  ] as const) {
    await expect(
      profiles.locator(`[data-account-category="${key}"] [data-switch-user]`),
    ).toHaveCount(count);
  }
  const volunteers = profiles.locator('[data-account-category="volunteers"]');
  await expect(
    volunteers.locator('[data-switch-user="new-state:medic"]'),
  ).toContainText("Medic eligible");
  await expect(
    volunteers.locator('[data-switch-user="new-state:patrol"]'),
  ).toContainText("Patrol approved");
  const orientation = profiles.locator('[data-account-category="orientation"]');
  await expect(
    orientation.locator('[data-switch-user="new-state:medic-orientee"]'),
  ).toContainText("Not medic eligible");
  await expect(
    orientation.locator('[data-switch-user="new-state:orientation-booked"]'),
  ).toContainText("Orientation booked");
  await page.setViewportSize({ width: 375, height: 812 });
  expect(
    await profiles.evaluate(
      (element) => element.scrollWidth <= element.clientWidth,
    ),
  ).toBe(true);
  await expect(
    profiles
      .getByRole("group", { name: "Account states", exact: true })
      .locator('[data-switch-user="new-state:organizer"]'),
  ).toBeVisible();
  // Verify actual authenticator enrollment using a separate request cookie jar.
  const switched = await request.post("/api/v1/auth/dev/switch-user", {
    headers: { origin: baseURL! },
    data: { userId: "local-account-user-organizer" },
  });
  expect(switched.ok()).toBe(true);
  const organizer = await (
    await request.get("/api/v1/auth/get-session")
  ).json();
  expect(organizer.user.twoFactorEnabled).toBe(true);
  await expect(
    profiles.locator('[data-switch-user="local-account-user-organizer"]'),
  ).toContainText("Patrol approved");
  const accountPage = await (await request.get("/volunteer/account")).text();
  expect(accountPage.match(/data-session-row/g)).toHaveLength(1);
  // A fresh session must resolve full application completion and real medic
  // eligibility through the normal portal, not just the development listing.
  for (const [key, patrolAccess] of [
    ["accepted", false],
    ["patrol", true],
    ["medic", true],
    ["inactive", false],
  ] as const) {
    const switched = await request.post("/api/v1/auth/dev/switch-user", {
      headers: { origin: baseURL! },
      data: { userId: `local-account-user-${key}` },
    });
    expect(switched.ok()).toBe(true);
    const portal = await (await request.get("/volunteer")).text();
    expect(portal.match(/data-application-tracker/g) ?? []).toHaveLength(0);
    expect(
      portal.includes('data-live-event="local-account-event-orientation"'),
    ).toBe(key !== "inactive");
    expect(
      portal.includes('data-live-event="local-account-event-patrol"'),
    ).toBe(patrolAccess);
  }
});

test("state buttons reuse a temporary sandbox and Draft always returns to the draft instead of saving progressed accounts", async ({
  page,
  baseURL,
}) => {
  const saved = await createLocalAccount(page.request, baseURL!);
  await page.goto("/volunteer/account");
  const current = async () =>
    (await (await page.request.get("/api/v1/auth/get-session")).json()).user;
  const draft = async () =>
    await (await page.request.get("/api/v1/account/application-draft")).json();
  const choose = async (id: string) => {
    const panel = await openLocalAccountSwitcher(page);
    await Promise.all([
      page.waitForEvent("domcontentloaded"),
      panel.locator(`[data-switch-user="${id}"]`).click(),
    ]);
  };
  await choose(accountStatePersona("draft"));
  await expect(page).toHaveURL(/\/apply$/);
  const sandbox = await current(),
    firstDraft = await draft();
  await expect(page.locator('[name="firstName"]')).toHaveValue("Casey");
  await page.locator('[name="firstName"]').fill("Old sandbox draft");
  await expect
    .poll(async () => (await draft()).draft?.answers.firstName)
    .toBe("Old sandbox draft");
  for (const step of ["form", "naloxone", "discord", "review"]) {
    const response = await page.request.post(
      "/api/v1/auth/dev/application-step",
      { headers: { origin: baseURL! }, data: { userId: sandbox.id, step } },
    );
    expect(response.ok(), await response.text()).toBe(true);
  }
  await page.goto("/volunteer");
  await expect(page.locator("[data-event-list]")).toBeVisible();
  for (let attempt = 0; attempt < 3; attempt++) {
    await choose(accountStatePersona("draft"));
    await expect(page).toHaveURL(/\/apply$/);
    expect((await current()).id).toBe(sandbox.id);
    await expect(page.locator('[name="firstName"]')).toHaveValue("Casey");
    const state = await draft();
    expect(state.submitted).toBe(false);
    expect(state.generation).not.toBe(firstDraft.generation);
    const panel = await openLocalAccountSwitcher(page);
    await expect(panel.locator('[data-application-step="form"]')).toBeEnabled();
    await expect(
      panel.locator(
        '[data-existing-accounts] [data-switch-user^="local-state-"]',
      ),
    ).toHaveCount(0);
    await expect(
      panel.locator(
        `[data-existing-accounts] [data-switch-user="${saved.id}"]`,
      ),
    ).toBeVisible();
    await page.keyboard.press("Alt+KeyZ");
  }
  await choose("new-application");
  await expect(page.locator('[name="firstName"]')).toHaveValue("");
  expect((await current()).id).toBe(sandbox.id);
  expect(await draft()).toMatchObject({ submitted: false, draft: null });
  await choose(saved.id);
  expect((await current()).id).toBe(saved.id);
  await expect(page.locator('[name="firstName"]')).toHaveValue(
    sampleAnswers.firstName,
  );
});

test("saved accounts keep their drafts and submitted answers and can be deleted", async ({
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
  const createSaved = async () => {
    await createLocalAccount(page.request, baseURL!, false);
    await page.goto("/apply");
    await expectBlank();
  };

  await createSaved();
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
    data: await profileWriteBody((path) => page.request.get(path), {
      ...sampleAnswers,
      teams: [],
      codeOfConductAccepted: true,
    }),
  });
  expect(invalid.status()).toBe(400);
  expect(await draft()).toMatchObject({
    submitted: false,
    draft: { answers: { firstName: "Unfinished draft" } },
  });
  expect(await disposableUsers()).toEqual(before);

  await createSaved();
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
    ["relevantExperience", "none"],
    ["heardAboutUsSources", "friend-word-of-mouth"],
  ])
    await page.locator(`[name="${name}"][value="${value}"]`).check();
  await submitLocalApplication(page);
  await expect(page).toHaveURL(/\/volunteer$/);
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
  await page.getByRole("button", { name: "Close DEV panel" }).click();

  await createSaved();
  const third = await current();
  const choices = await openLocalAccountSwitcher(page);
  const remove = choices.locator(`[data-delete-user="${second.id}"]`);
  const deletions: string[] = [];
  page.on("request", (request) => {
    if (request.url().endsWith("/api/v1/auth/dev/delete-user"))
      deletions.push(request.url());
  });
  await remove.click();
  await expect(remove).toHaveAccessibleName(/^Confirm deletion of/);
  await expect(remove.locator("svg path")).toHaveAttribute(
    "d",
    "m5 12 4 4L19 6",
  );
  expect(deletions).toHaveLength(0);
  await page.keyboard.press("Escape");
  await expect(choices).toBeVisible();
  await expect(remove).not.toHaveAttribute("data-delete-confirming");
  await remove.click();
  await choices.getByRole("heading", { name: "Existing accounts" }).click();
  await expect(remove).not.toHaveAttribute("data-delete-confirming");
  await remove.click();
  const panelBody = page.locator("[data-account-switcher] .dialog-body");
  const scrollBeforeDelete = await panelBody.evaluate((body) => body.scrollTop);
  expect(scrollBeforeDelete).toBeGreaterThan(0);
  await remove.click();
  await expect(remove).toHaveCount(0);
  await expect
    .poll(() => panelBody.evaluate((body) => body.scrollTop))
    .toBe(scrollBeforeDelete);
  expect(deletions).toHaveLength(1);
  expect((await current()).id).toBe(third.id);
  // Deleting the current account revokes its session and returns to Visitor.
  await choices.locator(`[data-delete-user="${third.id}"]`).click();
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

test("unfinished application shows current milestones and a keyboard-accessible form link without clipping", async ({
  page,
  baseURL,
}) => {
  await page.goto("/volunteer");
  const tracker = page.locator("[data-application-tracker]");
  const formLink = page.getByRole("link", {
    name: "Complete application form",
    exact: true,
  });
  await expect(tracker).toHaveCount(0);
  await createLocalAccount(page.request, baseURL!, false);
  await page.goto("/volunteer");
  await expect(tracker).toBeVisible();
  await expect(tracker.locator("[data-application-progress-step]")).toHaveCount(
    4,
  );
  await expect(
    tracker.locator('[data-application-progress-step="form"]'),
  ).toHaveAttribute("data-state", "current");
  const upcomingDiscord = tracker.locator(
    '[data-application-progress-step="discord"]',
  );
  await upcomingDiscord.locator(":scope > summary").click();
  await expect(
    upcomingDiscord.locator("[data-discord-connection] > p").first(),
  ).toHaveText(
    "Connect Discord to access our volunteer channels once you’re approved.",
  );
  await expect(upcomingDiscord.locator("[data-discord-connect]")).toHaveCount(
    0,
  );
  await expect(upcomingDiscord).not.toContainText(
    /Submit your application|complete Naloxone 101|before connecting Discord/i,
  );
  await expect(formLink).toHaveAttribute("href", "/apply");
  for (const width of [375, 320]) {
    await page.setViewportSize({ width, height: 812 });
    expect(
      await tracker.evaluate(
        (element) => element.scrollWidth <= element.clientWidth,
      ),
    ).toBe(true);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
    ).toBe(false);
  }
  await formLink.focus();
  await formLink.press("Enter");
  await expect(page).toHaveURL(/\/apply$/);
  await page.goto("/volunteer");
  await formLink.click();
  await expect(page).toHaveURL(/\/apply$/);
  const application = await page.request.post("/api/v1/account/profile", {
    headers: { origin: baseURL! },
    data: await profileWriteBody((path) => page.request.get(path), {
      ...sampleAnswers,
      codeOfConductAccepted: true,
    }),
  });
  expect(application.status(), await application.text()).toBe(200);
  await page.goto("/volunteer");
  await expect(formLink).toHaveCount(0);
  await expect(
    tracker.locator('[data-application-progress-step="form"]'),
  ).toHaveAttribute("data-state", "complete");
  await expect(
    tracker.locator('[data-application-progress-step="naloxone"]'),
  ).toHaveAttribute("data-state", "current");
  await expect(
    tracker.locator('[data-application-progress-step="review"]'),
  ).toHaveAttribute("data-state", "upcoming");
  await expect(page.locator("[data-event-list]")).toHaveCount(0);
});

test("Discord application step stays brief outside the current step", async ({
  page,
  baseURL,
}) => {
  const user = await createLocalAccount(page.request, baseURL!);
  await page.goto("/volunteer");
  const discord = page.locator('[data-application-progress-step="discord"]');
  await expect(discord).toHaveAttribute("data-state", "upcoming");
  await discord.locator(":scope > summary").click();
  await expect(
    discord.locator("[data-discord-connection] > p").first(),
  ).toHaveText(
    "Connect Discord to access our volunteer channels once you’re approved.",
  );
  await expect(discord.locator("[data-discord-connect]")).toHaveCount(0);
  await expect(discord).not.toContainText(
    /Submit your application|complete Naloxone 101|before connecting Discord/i,
  );
  await expect(
    discord.getByText("About Discord linking", { exact: true }),
  ).toHaveCount(0);

  let connection: "unlinked" | "linked" | "missing" | "error" = "unlinked";
  await page.route("**/api/v1/account/discord", async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    if (connection === "error")
      return route.fulfill({
        status: 503,
        json: { message: "Status is unavailable. Try again." },
      });
    return route.fulfill({
      json: {
        userId: user.id,
        configured: true,
        username: connection !== "unlinked" ? "volunteer" : null,
        discordId: connection !== "unlinked" ? "1564831264081715302" : null,
        needsReconnect: connection === "missing",
        memberVerifiedAt: connection === "linked" ? Date.now() : null,
        connection:
          connection === "missing"
            ? "Not in the server. Reconnect Discord to join again."
            : connection === "linked"
              ? "Server membership verified"
              : "Not connected",
        sync:
          connection === "linked"
            ? "Role sync pending"
            : "Connect Discord to enable role synchronization.",
      },
    });
  });

  // Completing the preceding step reveals the actions without changing the description.
  const naloxone = page.locator("[data-naloxone-confirm]");
  await naloxone.locator('[name="completed"]').check();
  await naloxone.getByRole("button", { name: "Confirm completion" }).click();
  await expect(discord).toHaveAttribute("data-state", "current");
  await expect(discord).toHaveAttribute("open", "");
  await expect(discord.locator("[data-discord-connect]")).toBeVisible();
  await expect(
    discord.getByRole("link", { name: "Privacy policy" }),
  ).toHaveCount(0);
  await expect(
    discord.locator("[data-discord-connection] details"),
  ).toHaveCount(0);
  await expect(
    discord.getByText("Email remains your sign-in method."),
  ).toHaveCount(0);

  const status = discord.locator("[data-discord-status]");
  const identity = discord.locator("[data-discord-identity]");
  const refresh = discord.locator("[data-discord-refresh]");
  // Handlers and polling remain available when the widget appears after load.
  await expect(status).toBeHidden({ timeout: 10_000 });
  await expect(identity).toBeHidden();
  await expect(refresh).toBeHidden();
  connection = "linked";
  await expect(identity).toHaveText("Connected as volunteer.", {
    timeout: 10_000,
  });
  await expect(identity).toBeVisible();
  await expect(refresh).toBeVisible();
  await expect(status).toContainText("Role sync pending");
  await expect(discord.locator("[data-discord-connect]")).toBeHidden();
  connection = "missing";
  await refresh.click();
  await expect(identity).toHaveText("Linked as volunteer.");
  await expect(
    discord.getByRole("button", { name: "Reconnect Discord" }),
  ).toBeVisible();
  connection = "linked";
  await refresh.click();
  await expect(identity).toHaveText("Connected as volunteer.");
  await expect(discord.locator("[data-discord-connect]")).toBeHidden();
  connection = "error";
  await refresh.click();
  await expect(status).toHaveText("Status is unavailable. Try again.");

  const completed = await page.request.post(
    "/api/v1/auth/dev/application-step",
    {
      headers: { origin: baseURL! },
      data: { userId: user.id, step: "discord" },
    },
  );
  expect(completed.ok(), await completed.text()).toBe(true);
  await page.evaluate(async () => {
    const response = await fetch(location.href);
    document.dispatchEvent(
      new CustomEvent("application-progress-updated", {
        detail: new DOMParser().parseFromString(
          await response.text(),
          "text/html",
        ),
      }),
    );
  });
  const review = page.locator('[data-application-progress-step="review"]');
  await expect(review).toHaveAttribute("data-state", "current");
  await expect(
    review.getByText("Pending approval", { exact: true }),
  ).toBeVisible();
  await expect(discord).toHaveAttribute("data-state", "complete");
  await discord.locator(":scope > summary").click();
  await expect(discord.locator("[data-discord-connection]")).toHaveCount(0);
  await expect(discord.locator(".application-progress-content")).toContainText(
    "Discord connected.",
  );
  const manage = discord.getByRole("link", {
    name: "Manage Discord connection",
  });
  await expect(manage).toHaveAttribute(
    "href",
    "/volunteer/account#account-discord-heading",
  );
  await manage.click();
  await expect(page.locator("[data-discord-connect]")).toBeHidden();
  await expect(page.locator("[data-discord-identity]")).toContainText(
    "Connected as",
  );
});

test("Connect Discord locally simulates consent, cancellation, failure and screening through the real UI", async ({
  page,
  baseURL,
}) => {
  const external: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).origin !== baseURL) external.push(request.url());
  });
  const endpoint = "/api/v1/account/discord";
  const post = (data: object, origin = baseURL!) =>
    page.request.post(endpoint, {
      headers: { origin },
      data,
    });
  expect((await post({})).status()).toBe(401);
  const user = await createLocalAccount(page.request, baseURL!);
  const input = { userId: user.id, consent: true, outcome: "authorize" };
  expect((await post(input, "https://unrelated.example.org")).status()).toBe(
    403,
  );
  expect((await post({ ...input, consent: false })).status()).toBe(400);
  expect((await post({ ...input, userId: "other" })).status()).toBe(403);
  expect((await post(input)).status()).toBe(409);

  await page.goto("/volunteer");
  const course = page.locator("[data-naloxone-confirm]");
  await course.locator('[name="completed"]').check();
  await course.getByRole("button", { name: "Confirm completion" }).click();
  const discord = page.locator('[data-application-progress-step="discord"]');
  await expect(discord).toHaveAttribute("data-state", "current");
  await expect(discord).not.toContainText(/not configured|coming soon/i);
  const form = discord.locator("[data-discord-connect]");
  const connect = form.getByRole("button", {
    name: "Connect Discord",
    exact: true,
  });
  await expect(connect).toBeEnabled();
  await expect(form.getByRole("checkbox")).toHaveCount(0);
  await expect(form.getByRole("link", { name: "Privacy policy" })).toHaveCount(
    0,
  );
  await connect.click();
  const dialog = page.getByRole("dialog", { name: "Authorize AHOI Bot" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("Local simulation");
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(form.locator("[data-discord-message]")).toContainText(
    "cancelled",
  );
  expect((await (await page.request.get(endpoint)).json()).username).toBeNull();
  await connect.click();
  await dialog
    .getByRole("button", { name: "Simulate Discord unavailable" })
    .click();
  await expect(form.locator("[data-discord-message]")).toHaveText(
    "Discord could not be connected. Please try again.",
  );
  await expect(connect).toBeEnabled();
  expect((await (await page.request.get(endpoint)).json()).username).toBeNull();

  await page.setViewportSize({ width: 320, height: 812 });
  await connect.click();
  expect(
    await dialog.evaluate(
      (element) => element.scrollWidth <= element.clientWidth,
    ),
  ).toBe(true);
  await dialog
    .getByRole("button", { name: "Simulate server rules required" })
    .click();
  await expect(discord.locator("[data-discord-status]")).toContainText(
    "Accept the server rules in Discord",
  );
  await expect(discord).toHaveAttribute("data-state", "current");
  await expect(page.getByText("Pending approval", { exact: true })).toHaveCount(
    0,
  );
  const pending = await (await page.request.get(endpoint)).json();
  expect(pending.completedAt).toBeNull();
  expect(pending.discordId).toBe(`local:${user.id}`);
  await expect(form).toBeHidden();
  // Accepting server rules happens in Discord, not by reauthorizing the link.
  const screened = await page.request.post(
    "/api/v1/auth/dev/application-step",
    {
      headers: { origin: baseURL! },
      data: { userId: user.id, step: "discord" },
    },
  );
  expect(screened.ok(), await screened.text()).toBe(true);
  await page.reload();
  await expect(discord).toHaveAttribute("data-state", "complete");
  const review = page.locator('[data-application-progress-step="review"]');
  await expect(review).toHaveAttribute("data-state", "current");
  await expect(
    review.getByText("Pending approval", { exact: true }),
  ).toBeVisible();
  await discord.locator(":scope > summary").click();
  await discord
    .getByRole("link", { name: "Manage Discord connection" })
    .click();
  await expect(page.locator("[data-discord-identity]")).toHaveText(
    "Connected as aho_volunteer.",
  );
  await expect(page.locator("[data-discord-status]")).toContainText(
    "Roles synchronized",
  );
  await expect(page.locator("[data-discord-connect]")).toBeHidden();
  const connected = await (await page.request.get(endpoint)).json();
  expect(connected.configured).toBe(true);
  expect(connected.completedAt).toBeGreaterThan(0);
  expect(connected.memberVerifiedAt).toBeGreaterThan(0);
  expect(external).toEqual([]);
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
  await expect(page).toHaveURL(/\/volunteer$/);
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
  await expect(page).toHaveURL(/\/volunteer$/);
  expect(new URL(page.url()).hash).toBe("");
  const replay = await request.post("/api/v1/auth/sign-in/email-otp", {
    headers: { origin: url.origin },
    data: { email: proof.email, otp: proof.otp },
  });
  expect(replay.status()).toBe(400);
  expect(external).toEqual([]);
});
