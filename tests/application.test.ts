import { afterEach, expect, test, vi } from "vitest";
import {
  latestApplicationBirthDate,
  normalizeCertifications,
} from "../src/data/application";
import { profileSchema } from "../src/server/db/profiles";

const birthDateSchema = profileSchema.shape.birthDate;

afterEach(() => vi.useRealTimers());

test.each([
  ["primary-care-paramedic", "paramedic"],
  ["advanced-care-paramedic", "paramedic"],
  ["critical-care-paramedic", "paramedic"],
  ["licensed-practical-nurse", "nurse"],
  ["registered-nurse", "nurse"],
  ["respiratory-therapist", "nurse-practitioner-physician"],
  ["nurse-practitioner", "nurse-practitioner-physician"],
  ["physician", "nurse-practitioner-physician"],
])("legacy %s maps to the combined %s option", (certification, combined) => {
  expect(normalizeCertifications([certification])).toEqual([combined]);
  expect(profileSchema.shape.certifications.parse([certification])).toEqual([
    combined,
  ]);
});

test("combined selections deduplicate without replacing other certifications", () => {
  const certifications = [
    "advanced-first-aid",
    "paramedic",
    "nurse",
    "nurse-practitioner-physician",
  ];
  expect(
    normalizeCertifications([
      "advanced-first-aid",
      "primary-care-paramedic",
      "advanced-care-paramedic",
      "critical-care-paramedic",
      "paramedic",
      "licensed-practical-nurse",
      "registered-nurse",
      "nurse",
      "nurse-practitioner",
      "physician",
      "nurse-practitioner-physician",
      "respiratory-therapist",
    ]),
  ).toEqual(certifications);
  const schema = profileSchema.shape.certifications;
  expect(schema.parse(["advanced-care-paramedic"])).toEqual(["paramedic"]);
  expect(
    schema.parse([
      "registered-nurse",
      "primary-care-paramedic",
      "critical-care-paramedic",
    ]),
  ).toEqual(["paramedic", "nurse"]);
});

test("First Responder is no longer a selectable certification", () => {
  expect(
    normalizeCertifications(["first-responder", "registered-nurse"]),
  ).toEqual(["nurse"]);
  expect(
    profileSchema.shape.certifications.safeParse(["first-responder"]).success,
  ).toBe(false);
});

test.each([
  ["", true],
  ["2030-10-14", true],
  ["2028-02-29", true],
  ["2027-02-29", false],
  ["2030-02-30", false],
  ["2030-13-01", false],
  ["2030-1-1", false],
  ["not-a-date", false],
])("certification expiry %s is valid: %s", (value, valid) => {
  expect(profileSchema.shape.certificationExpiry.safeParse(value).success).toBe(
    valid,
  );
});

test.each([
  ["2026-10-09T00:00:00Z", "2007-10-09"],
  ["2026-10-09T23:59:59Z", "2007-10-09"],
  ["2026-01-01T00:00:00Z", "2007-01-01"],
  ["2024-02-29T12:00:00Z", "2005-02-28"],
  ["2027-02-28T12:00:00Z", "2008-02-28"],
  ["2027-03-01T00:00:00Z", "2008-03-01"],
])("the cutoff at %s is %s", (today, cutoff) => {
  expect(latestApplicationBirthDate(new Date(today))).toBe(cutoff);
});

test.each([
  ["2007-10-08", true],
  ["2007-10-09", true],
  ["2007-10-10", false],
  ["2008-10-09", false],
  ["2027-01-01", false],
  ["1900-01-01", true],
  ["1899-12-31", false],
  ["2004-02-29", true],
  ["2005-02-29", false],
  ["2000-04-31", false],
  ["2000-13-01", false],
  ["2000-00-01", false],
  ["2000-01-00", false],
  ["2007-1-1", false],
  ["not-a-date", false],
  ["", false],
])("birth date %s is eligible: %s", (birthDate, eligible) => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-09T12:00:00Z"));
  const result = birthDateSchema.safeParse(birthDate);
  expect(result.success).toBe(eligible);
  if (!result.success) {
    for (const issue of result.error.issues) {
      expect(issue.message).toBe(
        "You must be at least 19 years old. Choose a valid date of birth.",
      );
    }
  }
});

test.each([
  ["2024-02-29T12:00:00Z", "2005-02-28", true],
  ["2024-02-29T12:00:00Z", "2005-03-01", false],
  ["2027-02-28T12:00:00Z", "2008-02-29", false],
  ["2027-03-01T00:00:00Z", "2008-02-29", true],
])("leap-year boundary at %s for %s: %s", (today, birthDate, eligible) => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(today));
  expect(birthDateSchema.safeParse(birthDate).success).toBe(eligible);
});

test("server validation recomputes the cutoff at midnight", () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-09T23:59:59Z"));
  expect(birthDateSchema.safeParse("2007-10-10").success).toBe(false);
  vi.setSystemTime(new Date("2026-10-10T00:00:00Z"));
  expect(birthDateSchema.safeParse("2007-10-10").success).toBe(true);
});
