import { expect, test } from "@playwright/test";

test("local approval notifications work without crypto.randomUUID", async ({
  page,
  baseURL,
}) => {
  test.skip(
    !baseURL?.startsWith("http://localhost:"),
    "Requires local development",
  );
  // HTTP LAN addresses and older browsers do not expose this secure-context API.
  await page.addInitScript(() => {
    Object.defineProperty(window.crypto, "randomUUID", {
      value: undefined,
      configurable: true,
    });
  });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  let approved = false;
  let version = 1;
  const submissions: object[] = [];
  const profile = () => `
    <div data-volunteer-profile>
      <h2>Sample volunteer</h2>
      <div class="volunteer-profile-controls" data-volunteer-controls>
        <form class="volunteer-form" data-organizer-status data-email-prompt="access" action="/api/organizer/action" method="post">
          <input type="hidden" name="userId" value="test-patrol" />
          <input type="hidden" name="version" value="${version}" />
          <input type="checkbox" name="active" checked hidden />
          <input type="checkbox" name="patrolApproved" ${approved ? "" : "checked"} hidden />
          <button class="btn btn-green" type="submit" data-loading-label="Saving…">${approved ? "Revoke patrol approval" : "Approve for patrols"}</button>
          <p data-form-message role="status" hidden></p>
        </form>
      </div>
    </div>`;
  // Keep this regression isolated from the developer's volunteers and email outbox.
  await page.route("**/api/organizer/action", async (route) => {
    const body = route.request().postDataJSON();
    submissions.push(body);
    approved = body.patrolApproved;
    version++;
    await route.fulfill({
      json: {
        message: "Volunteer access saved.",
        localNotifications: [
          {
            to: "sample@example.org",
            subject: "Volunteer access changed",
            body: `Patrol approval: ${approved}.`,
          },
        ],
      },
    });
  });
  await page.route("**/volunteer/volunteers/test-patrol", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: profile(),
    }),
  );
  await page.goto("/volunteer");
  await page.evaluate((html) => {
    const dialog = document.createElement("dialog");
    dialog.className = "volunteer-dialog";
    dialog.setAttribute("aria-label", "Test volunteer profile");
    dialog.innerHTML = html;
    document.querySelector(".volunteer-wrap")!.appendChild(dialog);
    dialog.showModal();
    document.documentElement.dataset.testDocument = "approval-regression";
  }, profile());
  const profileDialog = page.getByRole("dialog", {
    name: "Test volunteer profile",
  });
  const emailDialog = page.getByRole("dialog", { name: "Test email outcome" });
  const ids = new Set<string>();
  const documents: string[] = [];
  page.on("request", (request) => {
    if (request.resourceType() === "document") documents.push(request.url());
  });
  for (const approve of [true, false]) {
    await profileDialog
      .getByRole("button", {
        name: approve ? "Approve for patrols" : "Revoke patrol approval",
        exact: true,
      })
      .click();
    const choiceDialog = page.getByRole("dialog", {
      name: "Send an email?",
      exact: true,
    });
    await expect(choiceDialog).toBeVisible();
    expect(submissions).toHaveLength(approve ? 0 : 1);
    await choiceDialog
      .getByRole("button", { name: "Save and send email", exact: true })
      .click();
    await expect(emailDialog).toBeVisible();
    await expect(emailDialog).toContainText(`Patrol approval: ${approve}.`);
    const headingId = (await emailDialog.getAttribute("aria-labelledby"))!;
    expect(ids.has(headingId)).toBe(false);
    ids.add(headingId);
    await expect(emailDialog.locator(`h2[id="${headingId}"]`)).toHaveText(
      "Test email outcome",
    );
    await emailDialog
      .getByRole("button", { name: "Simulate successful delivery" })
      .click();
    await expect(
      profileDialog.getByRole("button", {
        name: approve ? "Revoke patrol approval" : "Approve for patrols",
        exact: true,
      }),
    ).toBeEnabled();
    await expect(profileDialog).toBeVisible();
    await expect(profileDialog.locator("[data-form-message]")).toBeHidden();
  }
  expect(submissions).toEqual([
    {
      action: "status",
      userId: "test-patrol",
      version: 1,
      active: true,
      patrolApproved: true,
      notify: true,
    },
    {
      action: "status",
      userId: "test-patrol",
      version: 2,
      active: true,
      patrolApproved: false,
      notify: true,
    },
  ]);
  expect(documents).toEqual([]);
  expect(
    await page.evaluate(() => document.documentElement.dataset.testDocument),
  ).toBe("approval-regression");
  expect(errors).toEqual([]);
});
