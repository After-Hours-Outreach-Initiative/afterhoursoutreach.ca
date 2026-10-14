export interface RegistrationAnswers {
  name: string;
  pronouns: string;
  phone: string;
  birthDate: string;
  emergencyName: string;
  emergencyPhone: string;
  emergencyRelationship: string;
  heardAboutUs: string;
  motivation: string;
  teams: string[];
  certifications: string[];
  certificationExpiry: string;
  // Retained for profiles created before the certification multiselect.
  certification: string;
  experience: string;
  training: string[];
  otherTraining: string;
  medicalConditions: string;
}

export function withOutreachTeam(teams: string[]): string[] {
  return ["outreach", ...teams.filter((team) => team !== "outreach")];
}

export const certificationQuestion =
  "Select the highest first-aid, medical, or health care certification or licence that you currently hold or are presently enrolled in schooling for.";

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
  "Do you have any of the following relevant training or experience? Select all that apply.";

export const trainingOptions = [
  {
    value: "naloxone-administration",
    label: "Naloxone administration training",
  },
  { value: "naloxone-trainer", label: "Certified naloxone trainer" },
  {
    value: "overdose-response",
    label:
      "Overdose response experience (naloxone, rescue breathing, CPR, etc.)",
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
    label: "Nonprofit grant writing, fundraising, or donor relations",
  },
  { value: "other", label: "Other" },
] as const;

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

export const registrationBirthDateError =
  "You must be at least 19 years old. Choose a valid date of birth on or after January 1, 1900.";

export function latestRegistrationBirthDate(today = new Date()): string {
  // Match the UTC calendar dates used by server validation, not elapsed days.
  const year = today.getUTCFullYear() - 19;
  const month = today.getUTCMonth();
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  // February 29 must not roll the cutoff forward into March in a non-leap year.
  return new Date(Date.UTC(year, month, Math.min(today.getUTCDate(), lastDay)))
    .toISOString()
    .slice(0, 10);
}

export const registrationFields = [
  {
    name: "name",
    section: "personal-info",
    label: "Full or preferred name",
    required: true,
    autocomplete: "name",
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
    type: "date",
    help: "You must be at least 19 years old to register.",
  },
  {
    name: "medicalConditions",
    section: "personal-info",
    label: "Medical conditions or triggers",
    required: false,
    multiline: true,
    help: "Optional. Used to help organizers support your safety during events.",
  },
  {
    name: "emergencyName",
    section: "emergency-contact",
    label: "Emergency contact name",
    required: true,
    help: "Someone we can contact if you need help during an event.",
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
    name: "heardAboutUs",
    section: "about-volunteering",
    label: "How did you hear about us?",
    required: true,
    registrationOnly: true,
  },
  {
    name: "motivation",
    section: "about-volunteering",
    label: "Why do you want to volunteer?",
    required: true,
    multiline: true,
    registrationOnly: true,
  },
  {
    name: "certificationExpiry",
    section: "training-and-safety",
    label: "Certification expiry date",
    required: true,
    type: "date",
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
    label: "Other relevant training or experience",
    required: true,
    multiline: true,
  },
] as const;

export const profileFields = registrationFields.filter(
  (field) => !("registrationOnly" in field),
);
