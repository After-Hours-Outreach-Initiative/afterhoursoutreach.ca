import { expect, test, type Page } from "@playwright/test";

const unexpectedRequests = new WeakMap<Page, string[]>();
// Keep the preview visible while exercising its notification dialogs.
async function showPreview(page: Page) {
  await page
    .locator("[data-ui-profile-frame]")
    .evaluate((frame) => frame.scrollIntoView({ block: "end" }));
}
test.beforeEach(async ({ page, baseURL }) => {
  test.skip(
    !baseURL?.startsWith("http://"),
    "Local-development playground only.",
  );
  const forbidden: string[] = [];
  unexpectedRequests.set(page, forbidden);
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (
      url.origin !== new URL(baseURL!).origin ||
      url.pathname.startsWith("/api/")
    ) {
      forbidden.push(url.href);
      await route.abort();
    } else await route.continue();
  });
});
test.afterEach(async ({ page }) =>
  expect(unexpectedRequests.get(page) ?? []).toEqual([]),
);

test("organizer profile catalogue exposes every real profile state without accounts or APIs", async ({
  page,
}) => {
  test.setTimeout(90_000);
  await page.goto("/dev/ui");
  await page
    .getByRole("navigation", { name: "Website parts" })
    .getByRole("link", { name: "Organizer profile", exact: true })
    .click();
  const preview = page.frameLocator("[data-ui-profile-frame]");
  await expect(
    page.getByRole("combobox", { name: "Presentation", exact: true }),
  ).toHaveCount(0);
  const states: Record<string, string> = {
    "naloxone-pending": "Complete Naloxone 101",
    "ready-for-review": "Application review",
    rejected: "Application rejected",
    accepted: "New volunteer",
    "orientation-booked": "New volunteer",
    "orientation-completed": "New volunteer",
    "medic-new-volunteer": "New volunteer",
    "outreach-volunteer": "Outreach Volunteer",
    medic: "Medic",
    inactive: "Outreach Volunteer",
    organizer: "Outreach Volunteer",
    "historic-approval": "New volunteer",
    "legacy-application": "Outreach Volunteer",
    "profile-updated": "Outreach Volunteer",
    "legacy-patrol": "Medic",
  };
  await expect(page.locator("[data-ui-profile-scenario]")).toHaveCount(15);
  for (const [id, step] of Object.entries(states)) {
    await page.locator(`[data-ui-profile-scenario="${id}"]`).click();
    await expect(
      preview.locator("[data-ui-organizer-preview]"),
    ).toHaveAttribute("data-ui-scenario", id);
    await expect(preview.locator("[data-application-current-step]")).toHaveText(
      step,
    );
    await expect(page.locator("[data-ui-profile-state]")).toContainText(
      `"scenario": "${id}"`,
    );
    await expect(preview.locator("[data-volunteer-profile]")).toBeVisible();
    await expect(
      preview.getByRole("dialog", { name: "Volunteer profile", exact: true }),
    ).toHaveCount(0);
  }
  await page.getByRole("searchbox", { name: "Find a state" }).fill("medic");
  await expect(page.locator("[data-ui-profile-scenario]:visible")).toHaveCount(
    2,
  );
  await page
    .getByRole("searchbox", { name: "Find a state" })
    .fill("no-such-state");
  await expect(page.getByText("No matching states.")).toBeVisible();
  await page.getByRole("searchbox", { name: "Find a state" }).fill("");
  await page
    .getByRole("combobox", { name: "Viewport width" })
    .selectOption("375");
  await page.reload();
  await expect(
    page.getByRole("combobox", { name: "Viewport width" }),
  ).toHaveValue("375");
  await expect(preview.locator("[data-application-current-step]")).toHaveText(
    "Medic",
  );
});

test("switching profile states preserves preview scrolling and reset starts at the top", async ({
  page,
}) => {
  await page.goto(
    "/dev/ui/organizer-profile?scenario=outreach-volunteer&height=600",
  );
  const preview = page.frameLocator("[data-ui-profile-frame]");
  const document = preview.locator("html");
  await expect(preview.locator("[data-volunteer-profile]")).toBeVisible();
  await document.evaluate((element) => {
    element.setAttribute("data-test-document", "preserved");
    window.scrollTo({ top: 900, behavior: "instant" });
  });
  await expect.poll(() => document.evaluate(() => window.scrollY)).toBe(900);

  for (const id of ["medic", "organizer", "inactive"]) {
    await page.locator(`[data-ui-profile-scenario="${id}"]`).click();
    await expect(
      preview.locator("[data-ui-organizer-preview]"),
    ).toHaveAttribute("data-ui-scenario", id);
    await expect.poll(() => document.evaluate(() => window.scrollY)).toBe(900);
    await expect(document).toHaveAttribute("data-test-document", "preserved");
  }

  await page
    .getByRole("button", { name: "Reset preview", exact: true })
    .click();
  await expect(page.locator("[data-ui-profile-frame]")).not.toHaveAttribute(
    "aria-busy",
    "true",
  );
  await expect.poll(() => document.evaluate(() => window.scrollY)).toBe(0);
  await expect(document).toHaveAttribute("data-test-document", "preserved");
});

test("state changes keep the current preview painted until its replacement is ready", async ({
  page,
}) => {
  await page.goto(
    "/dev/ui/organizer-profile?scenario=outreach-volunteer&height=600",
  );
  const preview = page.frameLocator("[data-ui-profile-frame]");
  const root = preview.locator("[data-ui-organizer-preview]");
  await expect(root).toHaveAttribute("data-ui-scenario", "outreach-volunteer");
  const documents: string[] = [];
  page.on("request", (request) => {
    if (
      request.isNavigationRequest() &&
      new URL(request.url()).pathname.endsWith("/organizer-profile/preview")
    )
      documents.push(request.url());
  });
  let release!: () => void;
  let requested!: () => void;
  const responseHeld = new Promise<void>((resolve) => (release = resolve));
  const requestStarted = new Promise<void>((resolve) => (requested = resolve));
  await page.route("**/dev/ui/organizer-profile/preview?**", async (route) => {
    if (
      new URL(route.request().url()).searchParams.get("scenario") === "medic"
    ) {
      requested();
      await responseHeld;
    }
    await route.continue();
  });
  await preview
    .locator("html")
    .evaluate(() => window.scrollTo({ top: 900, behavior: "instant" }));
  await page.locator('[data-ui-profile-scenario="medic"]').click();
  await requestStarted;
  await expect(page.locator("[data-ui-profile-frame]")).toHaveAttribute(
    "aria-busy",
    "true",
  );
  await expect(root).toHaveAttribute("data-ui-scenario", "outreach-volunteer");
  await expect(preview.locator("[data-volunteer-profile]")).toBeVisible();
  expect(await preview.locator("html").evaluate(() => window.scrollY)).toBe(
    900,
  );
  release();
  await expect(root).toHaveAttribute("data-ui-scenario", "medic");
  await expect
    .poll(() => preview.locator("html").evaluate(() => window.scrollY))
    .toBe(900);
  expect(documents).toEqual([]);
});

test("failed state changes retain the existing preview and can be retried", async ({
  page,
}) => {
  await page.goto("/dev/ui/organizer-profile?scenario=outreach-volunteer");
  const preview = page.frameLocator("[data-ui-profile-frame]");
  const root = preview.locator("[data-ui-organizer-preview]");
  await expect(root).toHaveAttribute("data-ui-scenario", "outreach-volunteer");
  await page.route("**/dev/ui/organizer-profile/preview?**", async (route) => {
    if (new URL(route.request().url()).searchParams.get("scenario") === "medic")
      await route.abort();
    else await route.continue();
  });
  await page.locator('[data-ui-profile-scenario="medic"]').click();
  await expect(page.locator("[data-ui-profile-status]")).toHaveText(
    "Preview could not be updated. Try again.",
  );
  await expect(root).toHaveAttribute("data-ui-scenario", "outreach-volunteer");
  await expect(preview.locator("[data-volunteer-profile]")).toBeVisible();
  await page.unroute("**/dev/ui/organizer-profile/preview?**");
  await page.locator('[data-ui-profile-scenario="medic"]').click();
  await expect(root).toHaveAttribute("data-ui-scenario", "medic");
});

test("real organizer controls simulate confirmation, cancellation, success, errors and pending saves", async ({
  page,
}) => {
  await page.goto("/dev/ui/organizer-profile?latency=0");
  const preview = page.frameLocator("[data-ui-profile-frame]");
  const approval = preview.getByRole("button", {
    name: "Approve application",
    exact: true,
  });
  await expect(approval).toBeEnabled();
  await showPreview(page);
  await approval.click();
  await preview
    .getByRole("button", { name: "Cancel change", exact: true })
    .click();
  await expect(preview.locator("[data-application-current-step]")).toHaveText(
    "Application review",
  );
  await expect(page.locator("[data-ui-profile-status]")).toContainText(
    "cancelled",
  );
  await approval.click();
  await preview
    .getByRole("button", { name: "Save without email", exact: true })
    .click();
  await expect(preview.locator("[data-application-current-step]")).toHaveText(
    "New volunteer",
  );
  for (const [outcome, error] of [
    ["failure", "The change could not be saved."],
    ["conflict", "This volunteer's status changed."],
  ]) {
    await page
      .getByRole("combobox", { name: "Action result" })
      .selectOption(outcome);
    await showPreview(page);
    await preview
      .getByRole("button", { name: "Approve for patrols", exact: true })
      .click();
    await preview
      .getByRole("button", { name: "Save without email", exact: true })
      .click();
    await expect(preview.getByRole("alert")).toContainText(error);
    await expect(preview.locator("[data-application-current-step]")).toHaveText(
      "New volunteer",
    );
  }
  await page
    .getByRole("combobox", { name: "Action result" })
    .selectOption("pending");
  await showPreview(page);
  await preview
    .getByRole("button", { name: "Approve for patrols", exact: true })
    .click();
  await preview
    .getByRole("button", { name: "Save without email", exact: true })
    .click();
  await expect(
    preview.locator('[data-organizer-status][data-access-kind="patrol"]'),
  ).toHaveAttribute("aria-busy", "true");
  await expect(page.locator("[data-ui-profile-status]")).toContainText(
    "saving",
  );
  await page
    .getByRole("button", { name: "Reset preview", exact: true })
    .click();
  await expect(approval).toBeEnabled();
  await expect(preview.locator("[data-application-current-step]")).toHaveText(
    "Application review",
  );
});

test("rejections and email failures update only fictional state, and prerequisites remain real", async ({
  page,
}) => {
  await page.goto("/dev/ui/organizer-profile?latency=0&outcome=email-failure");
  const preview = page.frameLocator("[data-ui-profile-frame]");
  await showPreview(page);
  await preview.getByText("Reject application", { exact: true }).click();
  await preview
    .getByRole("textbox", { name: "Reason for rejection" })
    .fill("Fictional review reason.\nA second line for layout checks.");
  await preview
    .getByRole("button", {
      name: "Reject application and email reason",
      exact: true,
    })
    .click();
  await expect(
    preview.getByRole("dialog", { name: "Application rejected", exact: true }),
  ).toBeVisible();
  await expect(
    preview.getByRole("dialog", { name: "Application rejected", exact: true }),
  ).toContainText("change is saved");
  await preview
    .getByRole("dialog", { name: "Application rejected", exact: true })
    .getByRole("button", { name: "Close" })
    .click();
  await expect(preview.locator("[data-application-rejection]")).toContainText(
    "Fictional review reason.",
  );
  await expect(preview.locator("[data-application-current-step]")).toHaveText(
    "Application rejected",
  );

  await page.locator('[data-ui-profile-scenario="naloxone-pending"]').click();
  await expect(preview.locator("[data-ui-organizer-preview]")).toHaveAttribute(
    "data-ui-scenario",
    "naloxone-pending",
  );
  await page
    .getByRole("combobox", { name: "Action result" })
    .selectOption("success");
  await showPreview(page);
  await preview
    .getByRole("button", { name: "Approve application", exact: true })
    .click();
  await preview
    .getByRole("button", { name: "Save without email", exact: true })
    .click();
  await expect(preview.getByRole("alert")).toHaveText(
    "The applicant must complete Naloxone 101 before approval.",
  );
});

test("active status, account roles and patrol access can be changed through the real controls", async ({
  page,
}) => {
  await page.goto(
    "/dev/ui/organizer-profile?scenario=outreach-volunteer&latency=0",
  );
  const preview = page.frameLocator("[data-ui-profile-frame]");
  const save = async () => {
    await preview
      .getByRole("button", { name: "Save without email", exact: true })
      .click();
    await expect(page.locator("[data-ui-profile-status]")).toContainText(
      "Simulation: saved",
    );
  };
  await showPreview(page);
  await preview
    .getByRole("checkbox", { name: "Active volunteer", exact: true })
    .uncheck();
  await save();
  await expect(
    preview.getByRole("checkbox", { name: "Active volunteer", exact: true }),
  ).not.toBeChecked();
  await expect(
    preview.getByText("Volunteer account inactive", { exact: true }),
  ).toBeVisible();
  await preview
    .getByRole("combobox", { name: "Account role", exact: true })
    .selectOption("organizer");
  await save();
  await expect(page.locator("[data-ui-profile-state]")).toContainText(
    '"role": "organizer"',
  );
  await preview
    .getByRole("button", { name: "Revoke patrol approval", exact: true })
    .click();
  await save();
  await expect(preview.locator("[data-application-current-step]")).toHaveText(
    "New volunteer",
  );
  await preview
    .getByRole("button", { name: "Approve for patrols", exact: true })
    .click();
  await save();
  await expect(preview.locator("[data-application-current-step]")).toHaveText(
    "Outreach Volunteer",
  );
});

test("profile previews stay on the page at every viewport, including old dialog bookmarks", async ({
  page,
}) => {
  test.setTimeout(60_000);
  await page.goto(
    "/dev/ui/organizer-profile?scenario=profile-updated&viewport=320&content=long&surface=dialog",
  );
  const preview = page.frameLocator("[data-ui-profile-frame]");
  for (const width of ["320", "375", "1440"]) {
    await page
      .getByRole("combobox", { name: "Viewport width" })
      .selectOption(width);
    await page
      .getByRole("combobox", { name: "Profile content" })
      .selectOption("long");
    await expect(preview.locator("[data-volunteer-profile]")).toBeVisible();
    await expect(
      preview.locator(
        "[data-profile-preview-content] > [data-volunteer-profile]",
      ),
    ).toBeVisible();
    await expect(
      preview.getByRole("dialog", { name: "Volunteer profile", exact: true }),
    ).toHaveCount(0);
    expect(
      await preview
        .locator("html")
        .evaluate(() => document.documentElement.scrollWidth > innerWidth),
    ).toBe(false);
    await page
      .getByRole("combobox", { name: "Loading state" })
      .selectOption("loading");
    await expect(
      preview.getByRole("status", { name: "" }).filter({ hasText: "Loading" }),
    ).toBeVisible();
    await page
      .getByRole("combobox", { name: "Loading state" })
      .selectOption("load-error");
    await expect(
      preview.getByText("Volunteer profile is temporarily unavailable.", {
        exact: true,
      }),
    ).toBeVisible();
    await page
      .getByRole("combobox", { name: "Loading state" })
      .selectOption("ready");
    await page
      .getByRole("combobox", { name: "Profile content" })
      .selectOption("minimal");
    await expect(
      preview.getByRole("heading", { name: "Alex Rivera", exact: true }),
    ).toBeVisible();
  }
});
