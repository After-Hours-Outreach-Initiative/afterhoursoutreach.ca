import type { Locator, Page } from "@playwright/test";

export async function fillDateInput(
  scope: Page | Locator,
  name: string,
  value: string,
) {
  const group = scope.locator(`[data-date-input="${name}"]`);
  const [date, time] = value.split("T");
  const native = group.locator("[data-native-date]");
  if (await native.count()) await native.fill(date);
  else {
    const [year, month, day] = date.split("-");
    for (const [part, answer] of Object.entries({ day, month, year }))
      await group.locator(`[data-date-part="${part}"]`).fill(answer ?? "");
  }
  if (time !== undefined)
    await group.locator("[data-date-time-input]").fill(time);
}
