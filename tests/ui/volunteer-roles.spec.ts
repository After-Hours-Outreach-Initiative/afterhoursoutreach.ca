import { expect, test } from "@playwright/test";
import { manualAccountPresets } from "../../src/dev/accounts";
import { signInLocalAuthenticatorAccount } from "../helpers/local-account";

test("local sample volunteers display all their role badges", async ({
  page,
  baseURL,
}) => {
  test.skip(!baseURL?.startsWith("http://localhost:"));
  const seeded = await page.request.post("/api/v1/auth/dev/seed-accounts", {
    headers: { origin: baseURL! },
    data: {},
  });
  expect(seeded.status(), await seeded.text()).toBe(200);
  await signInLocalAuthenticatorAccount(page.request, baseURL!);

  for (const width of [375, 1280]) {
    await page.setViewportSize({ width, height: 812 });
    for (const [key, roles] of [
      ["medic-new-volunteer", ["New", "Medic"]],
      ["organizer-medic", ["Organizer", "Medic"]],
      ["organizer-new-medic", ["Organizer", "New", "Medic"]],
      ["organizer", ["Organizer"]],
      ["medic", ["Medic"]],
      ["accepted", ["New"]],
    ] as const) {
      const preset = manualAccountPresets.find((preset) => preset.key === key)!;
      await page.goto(`/volunteers?q=${encodeURIComponent(preset.name)}`);
      const row = page.locator("[data-volunteer-row]").filter({
        has: page.locator(`a[href^="/volunteers/${preset.id}?"]`),
      });
      await expect(row.locator("[data-volunteer-role]")).toHaveText([...roles]);
    }
  }
});
