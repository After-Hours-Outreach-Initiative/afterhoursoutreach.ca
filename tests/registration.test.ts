import { afterEach, expect, test, vi } from "vitest";
import { latestRegistrationBirthDate } from "../src/data/registration";
import { profileSchema } from "../src/server/db/profiles";

const birthDateSchema = profileSchema.shape.birthDate;

afterEach(() => vi.useRealTimers());

test.each([
  ["2026-10-09T00:00:00Z", "2007-10-09"],
  ["2026-10-09T23:59:59Z", "2007-10-09"],
  ["2026-01-01T00:00:00Z", "2007-01-01"],
  ["2024-02-29T12:00:00Z", "2005-02-28"],
  ["2027-02-28T12:00:00Z", "2008-02-28"],
  ["2027-03-01T00:00:00Z", "2008-03-01"],
])("the cutoff at %s is %s", (today, cutoff) => {
  expect(latestRegistrationBirthDate(new Date(today))).toBe(cutoff);
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
  expect(birthDateSchema.safeParse(birthDate).success).toBe(eligible);
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
