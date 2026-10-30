import { manualAccountPresets } from "../src/dev/accounts";
import { sampleProfileFixtures } from "./sample-profile-fixtures";

/** Distinct manual identities; never rename the shared test/preview people. */
export function manualProfileFixture(
  preset: (typeof manualAccountPresets)[number],
  now: number,
) {
  const sample = sampleProfileFixtures("local", now).find(
    ({ key }) => key === preset.sampleKey,
  )!;
  const [firstName, ...surname] = preset.name.split(" ");
  const phone = 140 + manualAccountPresets.indexOf(preset) * 2;
  return {
    ...sample,
    id: preset.id,
    name: preset.name,
    email: `${preset.key}.v2.local@example.org`,
    answers: {
      ...sample.answers,
      firstName,
      middleNames: "",
      lastName: surname.join(" ") || "Sample",
      preferredName: firstName,
      teams: preset.sampleKey === "dana" ? ["outreach", "medic"] : ["outreach"],
      phone: `604-555-${phone.toString().padStart(4, "0")}`,
      emergencyPhone: `604-555-${(phone + 1).toString().padStart(4, "0")}`,
    },
  };
}
