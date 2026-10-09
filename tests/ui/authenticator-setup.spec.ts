import { expect, test } from "@playwright/test";
import jsQR from "jsqr";
import sharp from "sharp";
import { createLocalAccount } from "../helpers/local-account";
import { totpFromSetupKey } from "../helpers/totp";

test.beforeEach(async ({ page, baseURL }) => {
  test.skip(
    !baseURL?.startsWith("http://localhost:"),
    "Requires local development",
  );
  const ip = crypto.getRandomValues(new Uint8Array(2));
  await page.setExtraHTTPHeaders({
    "cf-connecting-ip": `198.18.${ip[0]}.${ip[1]}`,
  });
});

test("authenticator QR encodes the complete setup URI locally and is removed after verification", async ({
  page,
  baseURL,
}) => {
  await createLocalAccount(page.request, baseURL!);
  const external: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).origin !== new URL(baseURL!).origin)
      external.push(request.url());
  });
  await page.goto("/volunteer/account");
  const qr = page.getByRole("img", { name: "QR code for authenticator setup" });
  await expect(qr).toBeHidden();
  const response = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/v1/auth/two-factor/enable",
  );
  await page.getByRole("button", { name: "Set up an authenticator" }).click();
  const setup = await (await response).json();
  await expect(qr).toBeVisible();
  let decodedURI = "";
  for (const width of [1280, 375, 320]) {
    await page.setViewportSize({ width, height: 812 });
    // Decode rendered pixels, including responsive scaling on narrow screens.
    const { data, info } = await sharp(await qr.screenshot())
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    // Screenshot clipping rounds fractional CSS coordinates to whole pixels.
    expect(Math.abs(info.width - info.height)).toBeLessThanOrEqual(1);
    const decoded = jsQR(new Uint8ClampedArray(data), info.width, info.height);
    expect(decoded?.data).toBe(setup.totpURI);
    decodedURI = decoded!.data;
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
    ).toBe(false);
  }
  const secret = new URL(decodedURI).searchParams.get("secret")!;
  await expect(page.locator("[data-factor-key]")).toHaveText(secret);
  await expect(page.locator("[data-backup-codes]")).toHaveText(
    setup.backupCodes.join("\n"),
  );
  await expect(page.locator("[data-factor-qr-error]")).toBeHidden();
  await page
    .getByRole("textbox", { name: "Authenticator code", exact: true })
    .fill(totpFromSetupKey(secret));
  await page.getByRole("button", { name: "Verify and enable" }).click();
  await expect(
    page.getByText("Your authenticator is enabled.", { exact: false }),
  ).toBeVisible();
  await expect(page.locator("[data-factor-setup]")).toHaveCount(0);
  expect(external).toEqual([]);
});

test("manual authenticator setup still works when QR rendering is unavailable", async ({
  page,
  baseURL,
}) => {
  await createLocalAccount(page.request, baseURL!);
  await page.addInitScript(() => {
    HTMLCanvasElement.prototype.getContext = () => null;
  });
  await page.goto("/volunteer/account");
  await page.getByRole("button", { name: "Set up an authenticator" }).click();
  await expect(page.locator("[data-factor-setup]")).toBeVisible();
  await expect(page.locator("[data-factor-qr]")).toBeHidden();
  await expect(page.locator("[data-factor-qr-error]")).toBeVisible();
  const key = (await page.locator("[data-factor-key]").textContent())!;
  expect(key).toMatch(/^[A-Z2-7]+$/);
  await expect(page.locator("[data-backup-codes]")).not.toBeEmpty();
  await page
    .getByRole("textbox", { name: "Authenticator code", exact: true })
    .fill(totpFromSetupKey(key));
  await page.getByRole("button", { name: "Verify and enable" }).click();
  await expect(
    page.getByText("Your authenticator is enabled.", { exact: false }),
  ).toBeVisible();
});
