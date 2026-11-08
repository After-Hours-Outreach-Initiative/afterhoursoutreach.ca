import { expect, test } from "@playwright/test";

test("buttons playground shows shared variants, real states, and compact controls without overflow", async ({
  page,
  baseURL,
}) => {
  test.skip(
    !baseURL?.startsWith("http://"),
    "The playground is development-only.",
  );
  const response = await page.goto("/dev/ui/buttons");
  expect(response?.status()).toBe(200);
  expect(response?.headers()["content-security-policy"]).toBe(
    "form-action 'none'",
  );
  const navigation = page.getByRole("navigation", { name: "Website parts" });
  await expect(
    navigation.getByRole("link", { name: "Buttons", exact: true }),
  ).toHaveAttribute("aria-current", "page");
  await expect(navigation.locator('[aria-current="page"]')).toHaveCount(1);
  const showcase = page.locator("[data-ui-buttons-playground]");
  await expect(showcase.locator("[data-ui-button-variant]")).toHaveCount(6);
  for (const variant of [
    "primary",
    "outline",
    "subtle",
    "green",
    "red",
    "quiet",
  ]) {
    const card = showcase.locator(`[data-ui-button-variant="${variant}"]`);
    const buttons = card.locator(`button.btn.btn-${variant}`);
    await expect(buttons).toHaveCount(4);
    await expect(buttons.nth(0)).toBeEnabled();
    await expect(buttons.nth(1).locator("svg.btn-icon")).toHaveAttribute(
      "aria-hidden",
      "true",
    );
    await expect(buttons.nth(2)).toBeDisabled();
    await expect(buttons.nth(2)).toHaveCSS("opacity", "0.7");
    const busy = buttons.nth(3);
    await expect(busy).toBeDisabled();
    await expect(busy).toHaveAttribute("aria-busy", "true");
    expect(
      await busy.evaluate(
        (button) => getComputedStyle(button, "::before").animationName,
      ),
    ).toBe("volunteer-loading");
    await buttons.first().hover();
  }
  const primary = showcase
    .locator('[data-ui-button-variant="primary"] button')
    .first();
  await expect(primary).toHaveCSS("background-color", "rgb(65, 105, 225)");
  await primary.hover();
  await expect(primary).toHaveCSS("background-color", "rgb(47, 79, 181)");
  await navigation.getByRole("link").last().focus();
  await page.keyboard.press("Tab");
  await expect(primary).toBeFocused();
  await expect(primary).toHaveCSS("outline-style", "solid");
  await primary.click();
  await expect(page).toHaveURL(/\/dev\/ui\/buttons$/);
  await expect(showcase.locator('button:not([type="button"])')).toHaveCount(0);
  await expect(showcase.locator("form[action]")).toHaveCount(0);
  await expect(
    showcase.locator("form[data-save-changes] button").first(),
  ).toHaveCSS("background-color", "rgb(39, 39, 42)");
  for (const name of ["Registration actions example", "Close example"]) {
    const button = page.getByRole("button", { name, exact: true });
    await expect(button).toHaveCSS("width", "44px");
    await expect(button).toHaveCSS("height", "44px");
  }
  for (const width of [800, 375, 320]) {
    await page.setViewportSize({ width, height: 812 });
    expect(
      await page.evaluate(
        () =>
          document.documentElement.scrollWidth -
          document.documentElement.clientWidth,
      ),
    ).toBe(0);
  }
});
