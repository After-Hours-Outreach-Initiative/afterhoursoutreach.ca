import { expect, test } from "@playwright/test";

test("organizer email choice defaults to no email and cancellation restores controls", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  let approved = false;
  let version = 1;
  const submissions: object[] = [];
  const profile = () => `
    <div data-volunteer-profile>
      <h2>Sample volunteer</h2>
      <div data-volunteer-controls>
        <form data-organizer-status data-email-prompt="access" action="/api/v1/organizer/action" method="post">
          <input type="hidden" name="userId" value="test-email-choice" />
          <input type="hidden" name="version" value="${version}" />
          <input type="checkbox" name="active" checked hidden />
          <input type="checkbox" name="patrolApproved" ${approved ? "" : "checked"} hidden />
          <button type="submit" data-loading-label="Saving…">${approved ? "Revoke patrol approval" : "Approve for patrols"}</button>
          <p data-form-message hidden></p>
        </form>
        <form data-organizer-status data-submit-on-change data-email-prompt="access" action="/api/v1/organizer/action" method="post">
          <input type="hidden" name="userId" value="test-email-choice" />
          <input type="hidden" name="version" value="${version}" />
          <label><input type="checkbox" name="active" checked />Active volunteer</label>
          <input type="checkbox" name="patrolApproved" ${approved ? "checked" : ""} hidden />
          <span data-action-loading hidden>Saving…</span>
          <p data-form-message hidden></p>
        </form>
        <form data-organizer-role data-submit-on-change data-email-prompt="role" action="/api/v1/organizer/action" method="post">
          <input type="hidden" name="userId" value="test-email-choice" />
          <label>Account role<select name="role"><option value="volunteer">Volunteer</option><option value="organizer">Organizer</option></select></label>
          <span data-action-loading hidden>Saving…</span>
          <p data-form-message hidden></p>
        </form>
      </div>
    </div>`;
  await page.route("**/api/v1/organizer/action", async (route) => {
    const body = route.request().postDataJSON();
    submissions.push(body);
    approved = body.patrolApproved;
    version++;
    await route.fulfill({ json: { message: "Volunteer access saved." } });
  });
  await page.route("**/volunteer/volunteers/test-email-choice", (route) =>
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
    document.documentElement.dataset.testDocument = "optional-email";
  }, profile());
  const profileDialog = page.getByRole("dialog", {
    name: "Test volunteer profile",
    exact: true,
  });
  const choice = page.getByRole("dialog", {
    name: "Send an email?",
    exact: true,
  });
  const active = profileDialog.getByLabel("Active volunteer", { exact: true });
  await active.uncheck();
  await expect(choice).toBeVisible();
  await expect(
    choice.getByRole("button", { name: "Save without email", exact: true }),
  ).toBeFocused();
  expect(submissions).toEqual([]);
  // A second submit while awaiting consent cannot open another prompt or save.
  await page.evaluate(() =>
    document
      .querySelector<HTMLFormElement>(
        "[data-organizer-status][data-submit-on-change]",
      )!
      .requestSubmit(),
  );
  await expect(choice).toHaveCount(1);
  await choice
    .getByRole("button", { name: "Cancel change", exact: true })
    .click();
  await expect(active).toBeEnabled();
  await expect(active).toBeChecked();
  await expect(active).toBeFocused();
  await profileDialog.getByLabel("Account role").selectOption("organizer");
  await expect(choice).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(profileDialog.getByLabel("Account role")).toHaveValue(
    "volunteer",
  );
  await expect(profileDialog.getByLabel("Account role")).toBeEnabled();
  expect(submissions).toEqual([]);
  const approval = profileDialog.getByRole("button", {
    name: "Approve for patrols",
    exact: true,
  });
  await approval.click();
  await expect(choice).toBeVisible();
  await choice
    .getByRole("button", { name: "Cancel change", exact: true })
    .click();
  await expect(approval).toBeEnabled();
  await expect(approval).toBeFocused();
  expect(submissions).toEqual([]);
  await approval.click();
  await expect(choice).toBeVisible();
  await choice
    .getByRole("button", { name: "Save without email", exact: true })
    .click();
  await expect(
    profileDialog.getByRole("button", {
      name: "Revoke patrol approval",
      exact: true,
    }),
  ).toBeEnabled();
  expect(submissions).toEqual([
    {
      action: "status",
      userId: "test-email-choice",
      version: 1,
      active: true,
      patrolApproved: true,
      notify: false,
    },
  ]);
  await expect(
    page.getByRole("dialog", { name: "Test email outcome", exact: true }),
  ).toHaveCount(0);
  await expect(profileDialog).toBeVisible();
  expect(
    await page.evaluate(() => document.documentElement.dataset.testDocument),
  ).toBe("optional-email");
  expect(errors).toEqual([]);
});
