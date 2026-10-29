import { expect, test, type Page } from "@playwright/test";

const unexpectedRequests = new WeakMap<Page, string[]>();
// A modal inside an iframe cannot scroll its ancestor document into view.
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
    "legacy-patrol": "Outreach Volunteer",
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
    "Outreach Volunteer",
  );
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

test("dialog and page previews expose loading, unavailable, long and sparse layouts at mobile widths", async ({
  page,
}) => {
  test.setTimeout(60_000);
  await page.goto(
    "/dev/ui/organizer-profile?scenario=profile-updated&viewport=320&content=long",
  );
  const preview = page.frameLocator("[data-ui-profile-frame]");
  for (const surface of ["dialog", "page"]) {
    await page
      .getByRole("combobox", { name: "Profile content" })
      .selectOption("long");
    await page
      .getByRole("combobox", { name: "Presentation" })
      .selectOption(surface);
    await expect(preview.locator("[data-volunteer-profile]")).toBeVisible();
    expect(
      await preview
        .locator("html")
        .evaluate(() => document.documentElement.scrollWidth > innerWidth),
    ).toBe(false);
    if (surface === "dialog")
      expect(
        await preview
          .locator("[data-profile-dialog-content]")
          .evaluate((element) => element.scrollWidth > element.clientWidth),
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
      preview.getByText("Could not load the profile.", { exact: false }),
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
