import { afterEach, expect, test, vi } from "vitest";
import {
  applicationTeamOptions,
  latestApplicationBirthDate,
  normalizeCertifications,
  outreachRequiredError,
  profileFormSections,
  trainingOptions,
  experienceOptions,
  normalizeTrainingAnswers,
} from "../src/data/application";
import { profileSchema } from "../src/server/db/profiles";
import {
  applicationDraftAnswersSchema,
  draftProfileValues,
} from "../src/data/application-draft";
import { profileAnswerRows } from "../src/data/profile-answers";

const birthDateSchema = profileSchema.shape.birthDate;

test("team choices offer Outreach and Medic while saved retired answers remain readable", () => {
  expect(applicationTeamOptions.map((option) => option.value)).toEqual([
    "outreach",
    "medic",
  ]);
  const section = profileFormSections().find(
    (section) => section.key === "team-interests",
  )!;
  expect(
    profileAnswerRows(section, { teams: ["outreach", "non-patrol"] })[0].value,
  ).toEqual(["Outreach", "Non-patrol support"]);
});

test("training and experience offer separate, exact choices", () => {
  expect(trainingOptions.map((option) => option.label)).toEqual([
    "Naloxone administration training",
    "Basic First Aid, Emergency First Aid, Standard First Aid, or CPR certification",
    "Expired first-aid certification (specify under Other)",
    "Crisis intervention and de-escalation training (specify under Other)",
    "Mental Health First Aid or Psychological First Aid",
    "Other",
    "No relevant training",
  ]);
  expect(experienceOptions.map((option) => option.label)).toEqual([
    "Overdose response experience (naloxone, rescue breathing, CPR, etc.)",
    "Lived experience in the Downtown Eastside (DTES), with substance use, or in recovery",
    "Work or volunteer experience in the DTES or with vulnerable populations",
    "Experience in non-profit grant writing, fundraising, or donor relations",
    "Other",
    "No relevant experience",
  ]);
});

test("legacy combined answers split without inventing missing answers or losing text", () => {
  const original = {
    training: [
      "naloxone-administration",
      "overdose-response",
      "lived-experience",
      "naloxone-trainer",
      "other",
    ],
    otherTraining: "Original combined Other details",
  };
  const normalized = normalizeTrainingAnswers(original);
  expect(normalized).toEqual({
    training: ["naloxone-administration", "other"],
    otherTraining:
      "Original combined Other details\nCertified naloxone trainer",
    relevantExperience: ["overdose-response", "lived-experience"],
    otherExperience: "",
  });
  expect(original.training).toContain("naloxone-trainer");
  expect(normalizeTrainingAnswers(normalized)).toEqual(normalized);
  expect(
    normalizeTrainingAnswers({ training: ["none"] }).relevantExperience,
  ).toEqual(["none"]);
  expect(
    normalizeTrainingAnswers({ training: ["overdose-response"] }).training,
  ).toEqual([]);
  expect(
    normalizeTrainingAnswers({ training: ["naloxone-administration"] })
      .relevantExperience,
  ).toEqual([]);
  expect(
    normalizeTrainingAnswers({ training: ["none"], relevantExperience: [] })
      .relevantExperience,
  ).toEqual([]);
  expect(
    normalizeTrainingAnswers({
      training: [],
      otherTraining: "Saved hidden text",
    }).otherTraining,
  ).toBe("Saved hidden text");
});

test("both questions require an answer, exclusive None and conditional Other details", () => {
  const answers = {
    ...draftProfileValues(applicationDraftAnswersSchema.parse({})),
    firstName: "Sample",
    lastName: "Volunteer",
    phone: "6045550100",
    birthDate: "1990-01-01",
    emergencyName: "Contact",
    emergencyPhone: "6045550101",
    emergencyRelationship: "Friend",
    heardAboutUsSources: ["internet"],
    motivation: "Help my community",
    teams: ["outreach"],
    training: ["none"],
    relevantExperience: ["none"],
  };
  expect(profileSchema.safeParse(answers).success).toBe(true);
  for (const name of ["training", "relevantExperience"] as const) {
    const otherName = name === "training" ? "otherTraining" : "otherExperience";
    for (const values of [undefined, [], ["none", "other"], ["other", "other"]])
      expect(
        profileSchema.safeParse({ ...answers, [name]: values }).success,
      ).toBe(false);
    expect(
      profileSchema.safeParse({
        ...answers,
        [name]: ["other"],
        [otherName]: " \t ",
      }).success,
    ).toBe(false);
    const parsed = profileSchema.parse({
      ...answers,
      [name]: ["other"],
      [otherName]: " Details ",
    });
    expect(parsed[otherName]).toBe("Details");
  }
  expect(
    profileSchema.safeParse({ ...answers, training: ["naloxone-trainer"] })
      .success,
  ).toBe(false);
  expect(
    profileSchema.safeParse({ ...answers, training: ["overdose-response"] })
      .success,
  ).toBe(false);
  expect(
    profileSchema.safeParse({
      ...answers,
      relevantExperience: ["naloxone-administration"],
    }).success,
  ).toBe(false);
  const parsed = profileSchema.parse({
    ...answers,
    relevantExperience: ["other", "overdose-response"],
    otherExperience: "Details",
  });
  expect(parsed.relevantExperience).toEqual(["overdose-response", "other"]);
  const section = profileFormSections().find(
    (section) => section.key === "training-and-safety",
  )!;
  const rows = profileAnswerRows(section, parsed);
  expect(rows.find((row) => row.name === "training")?.value).toEqual([
    "No relevant training",
  ]);
  expect(rows.find((row) => row.name === "relevantExperience")?.value).toEqual([
    experienceOptions[0].label,
    "Other",
  ]);
  expect(rows.find((row) => row.name === "otherExperience")).toMatchObject({
    value: "Details",
    hidden: false,
  });
});

test("emergency contact helper text appears only in the application", () => {
  const emergencyContact = (application: boolean) =>
    profileFormSections(application).find(
      (section) => section.key === "emergency-contact",
    );
  expect(emergencyContact(false)?.description).toBeUndefined();
  expect(emergencyContact(true)?.description).toBe(
    "Someone we can contact if you need help during an event.",
  );
});

test("applications require an explicit Outreach selection and leave other teams optional", () => {
  const schema = profileSchema.shape.teams;
  for (const teams of [
    undefined,
    [],
    ["medic"],
    ["non-patrol"],
    ["medic", "non-patrol"],
  ]) {
    const parsed = schema.safeParse(teams);
    expect(parsed.success).toBe(false);
    if (!parsed.success)
      expect(parsed.error.issues[0].message).toBe(outreachRequiredError);
  }
  for (const teams of [
    ["outreach"],
    ["outreach", "medic"],
    ["outreach", "non-patrol"],
    ["outreach", "medic", "non-patrol"],
  ])
    expect(schema.parse(teams)).toEqual(teams);
});

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
