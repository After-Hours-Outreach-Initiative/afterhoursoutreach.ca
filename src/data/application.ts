import { isCalendarDate } from "./date-input";

export interface ApplicationAnswers {
  firstName: string;
  middleNames: string;
  lastName: string;
  preferredName: string;
  pronouns: string;
  phone: string;
  birthDate: string;
  emergencyName: string;
  emergencyPhone: string;
  emergencyRelationship: string;
  // Original free-text answer, retained without inferring multiple-choice answers.
  heardAboutUs: string;
  heardAboutUsSources: string[];
  heardAboutUsOther: string;
  motivation: string;
  teams: string[];
  certifications: string[];
  certificationExpiry: string;
  // Retained for profiles created before the certification multiselect.
  certification: string;
  experience: string;
  training: string[];
  otherTraining: string;
  relevantExperience: string[];
  otherExperience: string;
  medicalConditions: string;
}

/** The accepted submission, never rebuilt from the volunteer's current profile. */
export interface SubmittedApplication {
  version: 1;
  answers: ApplicationAnswers;
  email: string;
  submittedAt: string;
  codeOfConductVersion: string;
  codeOfConductAcceptedAt: string;
}

export const formatApplicationSubmittedTime = (value: string) =>
  new Date(value).toLocaleString("en-CA", {
    timeZone: "America/Vancouver",
    timeZoneName: "short",
  });

export function applicationDisplayName(
  answers: Pick<
    ApplicationAnswers,
    "firstName" | "middleNames" | "lastName" | "preferredName"
  >,
): string {
  return (
    answers.preferredName.trim() ||
    [answers.firstName, answers.middleNames, answers.lastName]
      .map((part) => part.trim())
      .filter(Boolean)
      .join(" ")
  );
}

export const outreachRequiredError =
  "Select Outreach to complete your application.";

export const applicationTeamOptions = [
  {
    value: "outreach",
    label: "Outreach",
    description: "Hand out supplies and connect with the DTES community.",
  },
  {
    value: "medic",
    label: "Medic",
    description: "Provide first aid and assist in emergency overdose response.",
    requirement:
      "Minimum requirement: Valid OFA Level 3 or Advanced First Aid certification.",
  },
  {
    value: "non-patrol",
    label: "Non-patrol support",
    description:
      "Assist with inventory, logistics, grant writing, community partnerships, and other operational needs.",
  },
] as const;

export const heardAboutUsQuestion = "How did you find out about us?";
export const heardAboutUsOptions = [
  { value: "social-media", label: "Social Media" },
  { value: "friend-word-of-mouth", label: "Friend/Word of mouth" },
  { value: "internet", label: "Internet" },
  { value: "other", label: "Other" },
] as const;
export const heardAboutUsOtherMaxLength = 200;

export const motivationMaxWords = 150;
export const motivationWordLimitError = `Keep this answer to ${motivationMaxWords} words or fewer.`;

/** Count whitespace-separated words identically in the browser and on the server. */
export function countWords(value: string): number {
  return value.match(/\S+/gu)?.length ?? 0;
}

export const certificationQuestion =
  "Select the highest first-aid, medical, or health care certification or licence that you currently hold.";

export const certificationOptions = [
  {
    value: "advanced-first-aid",
    label: "Advanced First Aid (formerly OFA Level 3)",
  },
  {
    value: "emergency-medical-responder",
    label: "Emergency Medical Responder (EMR)",
  },
  { value: "paramedic", label: "Paramedic (PCP, ACP, CCP)" },
  { value: "nurse", label: "Nurse (LPN, RN)" },
  {
    value: "nurse-practitioner-physician",
    label: "Respiratory Therapist (RT) / Nurse Practitioner (NP) / Physician",
  },
  { value: "other", label: "Other" },
] as const;

export const trainingQuestion =
  "Do you have any of the following relevant training? Select all that apply.";
export const trainingRequiredError =
  "Select at least one option, including No relevant training if none apply.";
export const trainingExclusiveError =
  "Select No relevant training on its own, or choose your relevant training.";
export const experienceQuestion =
  "Do you have any of the following relevant experience? Select all that apply.";
export const experienceRequiredError =
  "Select at least one option, including No relevant experience if none apply.";
export const experienceExclusiveError =
  "Select No relevant experience on its own, or choose your relevant experience.";
// Leave room for the removed trainer option alongside a full legacy Other answer.
export const otherTrainingMaxLength = 2048;

export const trainingOptions = [
  {
    value: "naloxone-administration",
    label: "Naloxone administration training",
  },
  {
    value: "basic-first-aid-cpr",
    label:
      "Basic First Aid, Emergency First Aid, Standard First Aid, or CPR certification",
  },
  {
    value: "expired-first-aid",
    label: "Expired first-aid certification (specify under Other)",
  },
  {
    value: "crisis-intervention",
    label:
      "Crisis intervention and de-escalation training (specify under Other)",
  },
  {
    value: "mental-health-first-aid",
    label: "Mental Health First Aid or Psychological First Aid",
  },
  { value: "other", label: "Other" },
  { value: "none", label: "No relevant training" },
] as const;

export const experienceOptions = [
  {
    value: "overdose-response",
    label:
      "Overdose response experience (naloxone, rescue breathing, CPR, etc.)",
  },
  {
    value: "lived-experience",
    label:
      "Lived experience in the Downtown Eastside (DTES), with substance use, or in recovery",
  },
  {
    value: "dtes-vulnerable-populations",
    label:
      "Work or volunteer experience in the DTES or with vulnerable populations",
  },
  {
    value: "nonprofit-fundraising",
    label:
      "Experience in non-profit grant writing, fundraising, or donor relations",
  },
  { value: "other", label: "Other" },
  { value: "none", label: "No relevant experience" },
] as const;

/** Split saved combined answers without guessing a negative answer for either question. */
export function normalizeTrainingAnswers<
  T extends {
    training?: string[];
    otherTraining?: string;
    relevantExperience?: string[] | null;
    otherExperience?: string;
  },
>(answers: T) {
  if (answers.relevantExperience != null)
    return {
      ...answers,
      training: answers.training ?? [],
      otherTraining: answers.otherTraining ?? "",
      relevantExperience: answers.relevantExperience,
      otherExperience: answers.otherExperience ?? "",
    };
  const combined = answers.training ?? [];
  const experienceValues: readonly string[] = experienceOptions
    .filter((option) => !["other", "none"].includes(option.value))
    .map((option) => option.value);
  const training = combined.filter(
    (value) =>
      !experienceValues.includes(value) && value !== "naloxone-trainer",
  );
  // Combined Other text cannot be reliably classified; retain it under training.
  let otherTraining = answers.otherTraining ?? "";
  // The removed option remains an editable answer, not a selectable certification.
  if (combined.includes("naloxone-trainer")) {
    if (!training.includes("other")) training.push("other");
    otherTraining = [otherTraining, "Certified naloxone trainer"]
      .filter(Boolean)
      .join("\n");
  }
  return {
    ...answers,
    training,
    otherTraining,
    relevantExperience: combined.filter(
      (value) => experienceValues.includes(value) || value === "none",
    ),
    otherExperience: answers.otherExperience ?? "",
  };
}

// Keep existing saved answers and older form submissions compatible.
const legacyCertificationAliases = new Map<string, string>([
  ["primary-care-paramedic", "paramedic"],
  ["advanced-care-paramedic", "paramedic"],
  ["critical-care-paramedic", "paramedic"],
  ["licensed-practical-nurse", "nurse"],
  ["registered-nurse", "nurse"],
  ["respiratory-therapist", "nurse-practitioner-physician"],
  ["nurse-practitioner", "nurse-practitioner-physician"],
  ["physician", "nurse-practitioner-physician"],
]);
export const legacyCertificationValues = [...legacyCertificationAliases.keys()];

export function normalizeCertifications(values: string[]): string[] {
  return [
    ...new Set(
      values
        .filter((value) => value !== "first-responder")
        .map((value) => legacyCertificationAliases.get(value) ?? value),
    ),
  ];
}

export const applicationBirthDateError =
  "You must be at least 19 years old. Choose a valid date of birth.";

export function latestApplicationBirthDate(today = new Date()): string {
  // Match the UTC calendar dates used by server validation, not elapsed days.
  const year = today.getUTCFullYear() - 19;
  const month = today.getUTCMonth();
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  // February 29 must not roll the cutoff forward into March in a non-leap year.
  return new Date(Date.UTC(year, month, Math.min(today.getUTCDate(), lastDay)))
    .toISOString()
    .slice(0, 10);
}

export function isValidApplicationBirthDate(value: string): boolean {
  return (
    isCalendarDate(value) &&
    value >= "1900-01-01" &&
    value <= latestApplicationBirthDate()
  );
}

export const applicationFields = [
  {
    name: "firstName",
    section: "personal-info",
    label: "First name",
    required: true,
    autocomplete: "given-name",
  },
  {
    name: "middleNames",
    section: "personal-info",
    label: "Middle name(s)",
    required: false,
    autocomplete: "additional-name",
  },
  {
    name: "lastName",
    section: "personal-info",
    label: "Last name",
    required: true,
    autocomplete: "family-name",
  },
  {
    name: "preferredName",
    section: "personal-info",
    label: "Preferred name",
    required: false,
    autocomplete: "nickname",
    help: "If provided, this is the name shown in your account and event rosters.",
  },
  {
    name: "pronouns",
    section: "personal-info",
    label: "Pronouns",
    required: false,
  },
  {
    name: "phone",
    section: "personal-info",
    label: "Phone number",
    required: true,
    type: "tel",
    autocomplete: "tel",
  },
  {
    name: "birthDate",
    section: "personal-info",
    label: "Date of birth",
    required: true,
    type: "text",
    help: "You must be at least 19 years old to apply.",
  },
  {
    name: "medicalConditions",
    section: "personal-info",
    label: "Medical conditions/allergies/anything else we should know",
    required: false,
    multiline: true,
    help: "Used to help organizers support your safety during events.",
  },
  {
    name: "emergencyName",
    section: "emergency-contact",
    label: "Emergency contact name",
    required: true,
  },
  {
    name: "emergencyPhone",
    section: "emergency-contact",
    label: "Emergency contact phone",
    required: true,
    type: "tel",
  },
  {
    name: "emergencyRelationship",
    section: "emergency-contact",
    label: "Relationship to emergency contact",
    required: true,
  },
  {
    name: "certificationExpiry",
    section: "training-and-safety",
    label: "Certification expiry date",
    required: true,
    type: "text",
  },
  {
    name: "experience",
    section: "training-and-safety",
    label: "Other training and experience",
    required: true,
    multiline: true,
  },
  {
    name: "otherTraining",
    section: "training-and-safety",
    label: "Other relevant training",
    required: true,
    multiline: true,
  },
  {
    name: "otherExperience",
    section: "training-and-safety",
    label: "Other relevant experience",
    required: true,
    multiline: true,
  },
  {
    name: "heardAboutUs",
    section: "about-volunteering",
    label: heardAboutUsQuestion,
    required: true,
    applicationOnly: true,
  },
  {
    name: "motivation",
    section: "about-volunteering",
    label: "Please tell us what motivates you volunteer with us?",
    required: true,
    multiline: true,
    applicationOnly: true,
    help: `${motivationMaxWords} words maximum.`,
  },
] as const;

export const profileFields = applicationFields.filter(
  (field) => !("applicationOnly" in field),
);

export const profileIdentityFields: readonly (keyof ApplicationAnswers)[] = [
  "firstName",
  "middleNames",
  "lastName",
  "birthDate",
];

/** Keep form sections and their contents links in the same order. */
export function profileFormSections(application = false) {
  const fields = application
    ? applicationFields
    : profileFields.filter(
        (field) => !profileIdentityFields.includes(field.name),
      );
  return [
    { key: "personal-info", heading: "Personal info" },
    {
      key: "emergency-contact",
      heading: "Emergency contact",
      description: application
        ? "Someone we can contact if you need help during an event."
        : undefined,
    },
    { key: "team-interests", heading: "Team interests" },
    { key: "training-and-safety", heading: "Training and safety" },
    { key: "about-volunteering", heading: "Personal statement" },
  ]
    .map((section) => ({
      ...section,
      fields: fields.filter((field) => field.section === section.key),
    }))
    .filter(
      (section) => section.key === "team-interests" || section.fields.length,
    );
}
