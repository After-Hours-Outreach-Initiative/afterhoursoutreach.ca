import type {
  ApplicationAnswers,
  SubmittedApplication,
} from "../src/data/application";
import { codeOfConductVersion } from "../src/data/code-of-conduct";

const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
const optionalAnswers = {
  heardAboutUs: "",
  heardAboutUsOther: "",
  certification: "",
  certifications: [],
  certificationExpiry: "",
  experience: "",
  otherTraining: "",
  relevantExperience: ["none"],
  otherExperience: "",
  medicalConditions: "",
};

/** Fictional adults; 555-0100–0199 numbers are reserved for fictional use. */
export function sampleProfileFixtures(
  environment: "local" | "preview",
  now: number,
) {
  const expiry = new Date(now);
  expiry.setUTCFullYear(expiry.getUTCFullYear() + 2);
  const certificationExpiry = expiry.toISOString().slice(0, 10);
  const people = [
    {
      key: "robin",
      answers: {
        ...optionalAnswers,
        firstName: "Robin",
        middleNames: "Morgan",
        lastName: "Vance",
        pronouns: "they/them",
        birthDate: "1987-06-18",
        emergencyName: "Taylor Vance",
        emergencyRelationship: "Sibling",
        heardAboutUsSources: ["friend-word-of-mouth"],
        motivation:
          "I want to help neighbours access practical support and build a welcoming, reliable evening outreach team.",
        teams: ["outreach", "non-patrol"],
        training: ["naloxone-administration"],
        relevantExperience: ["dtes-vulnerable-populations"],
      },
    },
    {
      key: "casey",
      answers: {
        ...optionalAnswers,
        firstName: "Casey",
        middleNames: "Jordan",
        lastName: "Lee",
        pronouns: "she/her",
        birthDate: "1996-02-24",
        emergencyName: "Avery Lee",
        emergencyRelationship: "Partner",
        heardAboutUsSources: ["social-media", "internet"],
        motivation:
          "I would like to listen, learn from experienced volunteers, and help distribute food and supplies consistently.",
        teams: ["outreach"],
        training: ["basic-first-aid-cpr"],
      },
    },
    {
      key: "dana",
      answers: {
        ...optionalAnswers,
        firstName: "Dana",
        middleNames: "Louise",
        lastName: "Whitfield",
        pronouns: "she/they",
        birthDate: "1990-09-07",
        emergencyName: "Quinn Whitfield",
        emergencyRelationship: "Sibling",
        heardAboutUsSources: ["friend-word-of-mouth", "other"],
        heardAboutUsOther: "A community centre volunteer information evening.",
        motivation:
          "I want to contribute my emergency response training while offering calm, respectful support to our neighbours.",
        teams: ["outreach", "medic"],
        certifications: ["emergency-medical-responder"],
        certificationExpiry,
        training: ["naloxone-administration"],
        relevantExperience: ["overdose-response"],
      },
    },
    {
      key: "alex",
      answers: {
        ...optionalAnswers,
        firstName: "Alex",
        middleNames: "Wei",
        lastName: "Chen",
        pronouns: "he/him",
        birthDate: "1993-11-15",
        emergencyName: "Riley Chen",
        emergencyRelationship: "Friend",
        heardAboutUsSources: ["internet"],
        motivation:
          "I want to support community-led outreach and help keep useful supplies available for people who need them.",
        teams: ["outreach", "non-patrol"],
        training: ["none"],
        relevantExperience: ["nonprofit-fundraising", "other"],
        otherExperience:
          "Two years coordinating donated supplies and inventory for a community pantry.",
      },
    },
    {
      key: "jamie",
      answers: {
        ...optionalAnswers,
        firstName: "Jamie",
        middleNames: "Min",
        lastName: "Park",
        pronouns: "they/she",
        birthDate: "1989-03-29",
        emergencyName: "Cameron Park",
        emergencyRelationship: "Spouse",
        heardAboutUsSources: ["other"],
        heardAboutUsOther: "A neighbourhood volunteer fair.",
        motivation:
          "I hope to offer steady, compassionate support and help connect neighbours with the supplies they request.",
        teams: ["outreach"],
        training: ["mental-health-first-aid"],
        relevantExperience: ["dtes-vulnerable-populations"],
      },
    },
    {
      key: "sam",
      answers: {
        ...optionalAnswers,
        firstName: "Sam",
        middleNames: "Gabriel",
        lastName: "Rivera",
        pronouns: "he/they",
        birthDate: "1985-12-03",
        emergencyName: "Drew Rivera",
        emergencyRelationship: "Sibling",
        heardAboutUsSources: ["social-media"],
        motivation:
          "I want to use my first-aid training to support safe outreach and help newer volunteers feel prepared.",
        teams: ["outreach", "medic"],
        certifications: ["advanced-first-aid"],
        certificationExpiry,
        training: ["naloxone-administration", "crisis-intervention", "other"],
        relevantExperience: ["overdose-response"],
        otherTraining:
          "Certified naloxone trainer. Completed a two-day nonviolent crisis intervention and de-escalation course; facilitated volunteer safety practice sessions.",
      },
    },
  ];
  return people.map(({ key, answers }, index) => {
    const name = `${answers.firstName} ${answers.lastName}${environment === "preview" ? " (sample)" : ""}`;
    const phone = (offset: number) =>
      `604-555-${String(100 + (environment === "preview" ? 20 : 0) + index * 2 + offset).padStart(4, "0")}`;
    return {
      key,
      name,
      id: `${environment}-fixture-user-${key}`,
      email:
        environment === "preview"
          ? `${key}@preview.example.invalid`
          : `${key}.local@example.org`,
      answers: {
        ...answers,
        preferredName: name,
        phone: phone(0),
        emergencyPhone: phone(1),
      } satisfies ApplicationAnswers,
    };
  });
}

export function sampleProfileStatement(
  person: ReturnType<typeof sampleProfileFixtures>[number],
  now: number,
  options: { naloxoneCompletedAt?: number | null } = {},
) {
  const a = person.answers;
  const submittedAt = new Date(now).toISOString();
  const snapshot: SubmittedApplication = {
    version: 1,
    answers: a,
    email: person.email,
    submittedAt,
    codeOfConductVersion,
    codeOfConductAcceptedAt: submittedAt,
  };
  // Only known synthetic IDs with their original synthetic email may be repaired.
  // REPLACE recreates this child row atomically, never the parent user. Nothing
  // references profile, so credentials, status, rosters and attendance cannot cascade.
  // A failed insert leaves the old row intact; no delete/insert failure window.
  // Completed snapshots (and subsequent profile edits) are always left untouched.
  // The immutable-snapshot trigger remains enabled, including its NULL protection.
  return `INSERT OR REPLACE INTO profile (
    user_id, first_name, middle_names, last_name, preferred_name, pronouns, phone,
    birth_date, emergency_contact_name, emergency_contact_phone, emergency_contact_relationship,
    heard_about_us, heard_about_us_sources, heard_about_us_other, motivation, teams,
    medical_certification, medical_certifications, medical_certification_expiry,
    training_experience, relevant_training, other_training, relevant_experience, other_experience, medical_conditions,
    code_of_conduct_version, code_of_conduct_accepted_at, submitted_application, naloxone_completed_at, registered_at, updated_at
  ) SELECT u.id, ${quote(a.firstName)}, ${quote(a.middleNames)}, ${quote(a.lastName)},
    ${quote(a.preferredName)}, ${quote(a.pronouns)}, ${quote(a.phone)}, ${quote(a.birthDate)},
    ${quote(a.emergencyName)}, ${quote(a.emergencyPhone)}, ${quote(a.emergencyRelationship)},
    ${quote(a.heardAboutUs)}, ${quote(JSON.stringify(a.heardAboutUsSources))}, ${a.heardAboutUsOther ? quote(a.heardAboutUsOther) : "NULL"},
    ${quote(a.motivation)}, ${quote(JSON.stringify(a.teams))}, ${quote(a.certification)},
    ${quote(JSON.stringify(a.certifications))}, ${a.certificationExpiry ? quote(a.certificationExpiry) : "NULL"},
    ${quote(a.experience)}, ${quote(JSON.stringify(a.training))}, ${quote(a.otherTraining)},
    ${quote(JSON.stringify(a.relevantExperience))}, ${quote(a.otherExperience)},
    ${a.medicalConditions ? quote(a.medicalConditions) : "NULL"}, ${quote(codeOfConductVersion)},
    ${now}, ${quote(JSON.stringify(snapshot))}, ${options.naloxoneCompletedAt ?? "NULL"}, ${now}, ${now}
  FROM user u WHERE u.id = ${quote(person.id)} AND u.email = ${quote(person.email)}
    AND NOT EXISTS (SELECT 1 FROM profile p WHERE p.user_id = u.id AND p.submitted_application IS NOT NULL)`;
}

/** Existing-volunteer sample personas exercise grandfathered access, not OAuth. */
export function sampleDiscordExemption(
  person: ReturnType<typeof sampleProfileFixtures>[number],
) {
  return `DELETE FROM discord_requirement WHERE user_id=${quote(person.id)}
    AND EXISTS(SELECT 1 FROM user WHERE id=${quote(person.id)} AND email=${quote(person.email)})`;
}
