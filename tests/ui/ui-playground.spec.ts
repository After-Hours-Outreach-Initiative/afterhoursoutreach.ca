import { expect, test } from "@playwright/test";

test("local Discord playground renders real controls and simulates without APIs", async ({
  page,
  baseURL,
}) => {
  test.setTimeout(60_000);
  test.skip(
    !baseURL?.startsWith("http://"),
    "The UI playground exists only in local development.",
  );
  const origin = new URL(baseURL!).origin;
  const forbidden: string[] = [];
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== origin || url.pathname.startsWith("/api/v1")) {
      forbidden.push(url.href);
      await route.abort();
    } else {
      await route.continue();
    }
  });

  await page.goto("/dev/ui?scenario=not-connected&latency=0");
  const preview = page.frameLocator("[data-ui-live-preview]");
  const root = preview.locator("[data-discord-connection]");
  const identity = root.locator("[data-discord-identity]");
  const strongUsername = identity.locator("strong[data-discord-username]");
  const status = root.locator("[data-discord-status]");
  const simulateUpdate = page.getByRole("button", { name: "Simulate update" });
  await expect(root).toHaveAttribute("data-ui-phase", "idle");
  await expect(page.locator("[data-ui-simulation-status]")).toHaveText(
    "Simulation: idle",
  );
  await expect(page.locator("[data-ui-state]")).toContainText(
    '"phase": "idle"',
  );
  await expect(
    preview.getByRole("button", { name: "Connect Discord", exact: true }),
  ).toBeVisible();
  await expect(root.locator("[data-discord-refresh]")).toHaveCount(0);
  await expect(simulateUpdate).toBeDisabled();

  await page
    .getByRole("combobox", { name: "Scenario", exact: true })
    .selectOption("upcoming");
  await expect(page).toHaveURL(/scenario=upcoming/);
  await expect(root).toHaveAttribute("data-ui-phase", "idle");
  await expect(root.locator("[data-discord-connect]")).toHaveCount(0);
  await expect(root.locator("[data-discord-description]")).toBeVisible();
  await expect(root.locator("[data-discord-description]")).not.toContainText(
    "Connect Discord to",
  );
  await page.reload();
  await expect(
    page.getByRole("combobox", { name: "Scenario", exact: true }),
  ).toHaveValue("upcoming");
  await expect(root.locator("[data-discord-connect]")).toHaveCount(0);
  await page.getByRole("checkbox", { name: "Prior steps complete" }).check();
  await expect(
    preview.getByRole("button", { name: "Connect Discord", exact: true }),
  ).toBeVisible();

  await page
    .getByRole("combobox", { name: "Scenario", exact: true })
    .selectOption("not-connected");
  await page.getByRole("checkbox", { name: "Required step" }).uncheck();
  await expect(root.locator("[data-discord-description]")).toContainText(
    "This is optional.",
  );
  await page
    .getByRole("combobox", { name: "Preview size" })
    .selectOption("narrow");
  await expect(page.locator("[data-ui-live-preview]")).toHaveAttribute(
    "width",
    "360",
  );
  await page.getByRole("button", { name: "Use long name" }).click();
  const username = await page.getByLabel("Fictional username").inputValue();
  expect(username.length).toBeGreaterThan(70);

  await page
    .getByRole("combobox", { name: "Connect result" })
    .selectOption("failure");
  await preview
    .getByRole("button", { name: "Connect Discord", exact: true })
    .click();
  await expect(root.locator("[data-discord-message]")).toContainText(
    "could not be connected",
  );
  await page
    .getByRole("combobox", { name: "Connect result" })
    .selectOption("cancel");
  await preview
    .getByRole("button", { name: "Connect Discord", exact: true })
    .click();
  await expect(root.locator("[data-discord-message]")).toContainText(
    "cancelled",
  );

  await page
    .getByRole("combobox", { name: "Connect result" })
    .selectOption("screening");
  await preview
    .getByRole("button", { name: "Connect Discord", exact: true })
    .click();
  await expect(status).toContainText("Accept the server rules");
  await expect(identity).toHaveText(`Connected as @${username}`);
  await expect(strongUsername).toHaveText(`@${username}`);
  await expect(root.locator("[data-discord-description]")).toBeHidden();
  await expect(status).not.toContainText("Role sync pending");
  await simulateUpdate.click();
  await expect(identity).toHaveText(`Connected as @${username}`);
  await expect(strongUsername).toHaveText(`@${username}`);
  await expect(status).toBeHidden();
  await expect(status).toHaveText("");
  await expect(root.locator("[data-discord-description]")).toBeHidden();
  await expect(root.locator("[data-discord-refresh]")).toHaveCount(0);
  await expect(root).not.toContainText(
    /Server membership verified|Roles synchronized|Role sync pending/,
  );
  expect(await preview.locator("html").evaluate(() => window.innerWidth)).toBe(
    360,
  );
  expect(
    await root.evaluate(
      (element) => element.scrollWidth <= element.clientWidth,
    ),
  ).toBe(true);

  await page
    .getByRole("combobox", { name: "Background update" })
    .selectOption("pending");
  await simulateUpdate.click();
  await expect(root).toHaveAttribute("data-ui-phase", "sync-pending");
  await expect(identity).toHaveText(`Connected as @${username}`);
  await expect(status).toBeHidden();
  await expect(status).toHaveText("");
  await page
    .getByRole("combobox", { name: "Background update" })
    .selectOption("error");
  await simulateUpdate.click();
  await expect(status).toHaveText(
    "Discord status is temporarily unavailable. Please try again later.",
  );
  await expect(identity).toHaveText(`Connected as @${username}`);
  await expect(strongUsername).toHaveText(`@${username}`);
  await page
    .getByRole("combobox", { name: "Background update" })
    .selectOption("pause");
  await simulateUpdate.click();
  await expect(status).toContainText("Discord requested a pause");
  await page
    .getByRole("combobox", { name: "Background update" })
    .selectOption("reconnect");
  await simulateUpdate.click();
  await expect(identity).toHaveText(`Connected as @${username}`);
  await expect(strongUsername).toHaveText(`@${username}`);
  await expect(
    preview.getByRole("button", { name: "Reconnect Discord", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("combobox", { name: "Connect result" })
    .selectOption("authorize");
  await preview
    .getByRole("button", { name: "Reconnect Discord", exact: true })
    .click();
  await expect(root).toHaveAttribute("data-ui-phase", "synced");
  await expect(identity).toHaveText(`Connected as @${username}`);
  await expect(strongUsername).toHaveText(`@${username}`);
  await expect(status).toBeHidden();
  await expect(status).toHaveText("");
  await expect(root.locator("[data-discord-description]")).toBeHidden();

  await page
    .getByRole("combobox", { name: "Preview size" })
    .selectOption("desktop");
  await expect(page.locator("[data-ui-live-preview]")).toHaveAttribute(
    "width",
    "1024",
  );
  await page
    .getByRole("combobox", { name: "Scenario", exact: true })
    .selectOption("screening");
  await expect(root.locator("[data-discord-status]")).toContainText(
    "Accept the server rules",
  );
  await page.getByRole("button", { name: "Reset simulator" }).click();
  await expect(page).toHaveURL(/scenario=screening/);
  await expect(root).toHaveAttribute("data-ui-phase", "idle");
  await expect(root.locator("[data-discord-status]")).toContainText(
    "Accept the server rules",
  );
  expect(forbidden).toEqual([]);
});
