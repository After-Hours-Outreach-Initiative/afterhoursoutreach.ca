import { expect, test, type Locator, type Page } from "@playwright/test";

const unexpectedRequests = new WeakMap<Page, string[]>();
const currentProfileState =
  '[data-patrol-status], [data-patrol-approval] .btn-red, [data-application-mini-step][aria-current="step"] .application-progress-mini-title';

async function expectOrganizerField(field: Locator, label: string) {
  const term = field.locator("dt");
  const value = field.locator("dd");
  await expect(term).toHaveText(label);
  await expect(term).toHaveCSS("color", "rgb(161, 161, 170)");
  await expect(value).toHaveText("Morgan C. (morgan.organizer@example.org)");
  await expect(value).toHaveCSS("color", "rgb(244, 244, 245)");
  const labelBounds = (await term.boundingBox())!;
  const valueBounds = (await value.boundingBox())!;
  expect(valueBounds.y).toBeGreaterThanOrEqual(
    labelBounds.y + labelBounds.height,
  );
}
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
    "naloxone-pending": "Naloxone 101",
    "ready-for-review": "Application review",
    rejected: "Application review",
    "medic-applicant": "Application review",
    accepted: "Awaiting patrol approval",
    "orientation-booked": "Awaiting patrol approval",
    "orientation-completed": "Awaiting patrol approval",
    "medic-new-volunteer": "Awaiting patrol approval",
    "outreach-volunteer": "Revoke patrol approval",
    medic: "Revoke patrol approval",
    inactive: "Revoke patrol approval",
    organizer: "Revoke patrol approval",
    "historic-approval": "Awaiting patrol approval",
    "legacy-application": "Revoke patrol approval",
    "profile-updated": "Revoke patrol approval",
    "legacy-patrol": "Revoke patrol approval",
  };
  await expect(page.locator("[data-ui-profile-scenario]")).toHaveCount(16);
  for (const [id, step] of Object.entries(states)) {
    await page.locator(`[data-ui-profile-scenario="${id}"]`).click();
    await expect(
      preview.locator("[data-ui-organizer-preview]"),
    ).toHaveAttribute("data-ui-scenario", id);
    await expect(preview.locator(currentProfileState)).toHaveText(step);
    await expect(
      preview.locator("[data-volunteer-profile-overview]"),
    ).toHaveText("Alex Jordan Rivera");
    const patrolApproval = preview.getByRole("region", {
      name: "Patrol Approval",
      exact: true,
    });
    await expect(patrolApproval).toBeVisible();
    await expect(patrolApproval.getByRole("list")).toHaveCount(0);
    await expect(patrolApproval.getByRole("button")).toHaveCount(
      ["Awaiting patrol approval", "Revoke patrol approval"].includes(step)
        ? 1
        : 0,
    );
    await expect(
      preview.locator(
        '.volunteer-profile-controls [data-access-kind="patrol"]',
      ),
    ).toHaveCount(0);
    if (step === "Revoke patrol approval") {
      await expect(patrolApproval.locator("[data-patrol-status]")).toHaveCount(
        0,
      );
      await expect(
        patrolApproval.getByText("Orientation not completed", { exact: true }),
      ).toHaveCount(0);
      await expect(
        patrolApproval.getByText("Patrol access approved", { exact: true }),
      ).toHaveCount(0);
      await expect(
        patrolApproval.locator("[data-orientation-status]"),
      ).toHaveCount(id === "legacy-patrol" ? 0 : 1);
    }
    await expect(
      preview.locator(
        '[data-volunteer-profile-panel="application"] .application-progress-mini-title',
      ),
    ).toHaveText(["Application form", "Naloxone 101", "Application review"]);
    if (id === "accepted") {
      const attribution = preview.locator("[data-application-approved-by]");
      await expectOrganizerField(attribution, "Approved by");
      await expect(attribution.locator("time")).toHaveCount(0);
    }
    if (id === "historic-approval")
      await expect(
        preview.locator('[data-application-mini-step="review"]'),
      ).toContainText("Approving organizer not recorded.");
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
    3,
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
  await expect(preview.locator(currentProfileState)).toHaveText(
    "Revoke patrol approval",
  );
});

test("application summaries hide unselected medic details and empty optional answers", async ({
  page,
}) => {
  for (const scenario of ["ready-for-review", "medic-applicant"]) {
    for (const content of ["standard", "long"]) {
      await page.goto(
        `/dev/ui/organizer-profile?scenario=${scenario}&content=${content}`,
      );
      const preview = page.frameLocator("[data-ui-profile-frame]");
      const application = preview.locator(
        '[data-volunteer-profile-panel="application"]',
      );
      const submitted = application.locator(
        '[data-application-mini-step="form"] details',
      );
      await submitted.locator("summary").click();
      for (const label of [
        "Highest medical certification or licence",
        "Certification expiry date",
      ])
        await expect(submitted.getByText(label, { exact: true })).toHaveCount(
          scenario === "medic-applicant" ? 1 : 0,
        );
      await expect(
        submitted.getByText("Other training and experience", { exact: true }),
      ).toHaveCount(0);
      for (const label of [
        "Other relevant training",
        "Other relevant experience",
      ])
        await expect(submitted.getByText(label, { exact: true })).toHaveCount(
          content === "long" ? 1 : 0,
        );
      await expect(
        submitted.getByText("Relevant training", { exact: true }),
      ).toBeVisible();
      await expect(
        submitted.getByText("Relevant experience", { exact: true }),
      ).toBeVisible();
    }
  }
});

test("organizer profiles omit empty middle names but retain provided names", async ({
  page,
}) => {
  for (const scenario of ["ready-for-review", "profile-updated"]) {
    for (const content of ["minimal", "standard"]) {
      await page.goto(
        `/dev/ui/organizer-profile?scenario=${scenario}&content=${content}`,
      );
      const preview = page.frameLocator("[data-ui-profile-frame]");
      await expect(preview.locator("[data-volunteer-profile]")).toBeVisible();
      const middleNames = preview
        .locator("dt")
        .filter({ hasText: /^Middle name\(s\)$/ });
      const expected =
        content === "minimal" ? 0 : scenario === "profile-updated" ? 2 : 1;
      await expect(middleNames).toHaveCount(expected);
      await expect(middleNames.locator("+ dd")).toHaveText(
        Array(expected).fill("Jordan"),
      );
    }
  }
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
  await expect(preview.locator(currentProfileState)).toHaveText(
    "Application review",
  );
  await expect(page.locator("[data-ui-profile-status]")).toContainText(
    "cancelled",
  );
  await approval.click();
  await preview
    .getByRole("button", { name: "Save without email", exact: true })
    .click();
  await expect(preview.locator(currentProfileState)).toHaveText(
    "Awaiting patrol approval",
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
    await expect(preview.locator(currentProfileState)).toHaveText(
      "Awaiting patrol approval",
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
  await expect(preview.locator(currentProfileState)).toHaveText(
    "Application review",
  );
});

test("rejections and email failures update only fictional state, and prerequisites remain real", async ({
  page,
}) => {
  await page.goto(
    "/dev/ui/organizer-profile?latency=0&outcome=email-failure&viewport=375",
  );
  const preview = page.frameLocator("[data-ui-profile-frame]");
  await showPreview(page);
  const rejectAction = preview.getByText("Reject application", {
    exact: true,
  });
  await expect(rejectAction).toHaveClass(/\bbtn btn-red\b/);
  for (const button of [
    preview.getByRole("button", { name: "Approve application", exact: true }),
    rejectAction,
  ]) {
    await expect
      .poll(() =>
        button.evaluate((button) =>
          Math.abs(
            button.getBoundingClientRect().width -
              button
                .closest(".application-decision-actions")!
                .getBoundingClientRect().width,
          ),
        ),
      )
      .toBeLessThan(1);
  }
  await rejectAction.click();
  await page.mouse.move(0, 0);
  await preview
    .getByRole("textbox", { name: "Reason for rejection" })
    .fill("Fictional review reason.\nA second line for layout checks.");
  await expect(rejectAction).toHaveCSS(
    "background-color",
    await preview
      .getByRole("button", { name: "Reject application and email reason" })
      .evaluate((button) => getComputedStyle(button).backgroundColor),
  );
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
  await expect(
    preview.locator('[data-application-mini-step="review"]'),
  ).toHaveAttribute("data-state", "rejected");

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
  await expect(preview.locator(currentProfileState)).toHaveText(
    "Awaiting patrol approval",
  );
  const patrolChange = preview.locator("[data-patrol-access-change]");
  await expectOrganizerField(
    patrolChange.locator("dl > div").first(),
    "Revoked by",
  );
  await expect(patrolChange.locator("dt").last()).toHaveText("Revoked on");
  await expect(patrolChange.locator("dd").last()).toHaveCSS(
    "color",
    "rgb(244, 244, 245)",
  );
  await expect(patrolChange.locator("time")).toHaveAttribute(
    "datetime",
    /T.*Z$/,
  );
  await preview
    .getByRole("button", { name: "Approve for patrols", exact: true })
    .click();
  await save();
  await expect(preview.locator(currentProfileState)).toHaveText(
    "Revoke patrol approval",
  );
  await expectOrganizerField(
    patrolChange.locator("dl > div").first(),
    "Approved by",
  );
  await expect(patrolChange.locator("dt").last()).toHaveText("Approved on");
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
    const approvalFields = preview.locator(
      "[data-patrol-access-change] dl > div",
    );
    await expect
      .poll(() =>
        approvalFields.evaluateAll((fields) => {
          const [organizer, date] = fields.map((field) =>
            field.getBoundingClientRect(),
          );
          return Boolean(
            organizer?.height &&
            date?.height &&
            date.top >= organizer.bottom &&
            date.left === organizer.left,
          );
        }),
      )
      .toBe(true);
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
