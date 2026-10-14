import { eq } from "drizzle-orm";
import { z } from "zod";
import {
  certificationOptions,
  legacyCertificationValues,
  latestApplicationBirthDate,
  normalizeCertifications,
  applicationBirthDateError,
  withOutreachTeam,
  trainingOptions,
  applicationDisplayName,
  heardAboutUsOptions,
  heardAboutUsOtherMaxLength,
  type ApplicationAnswers,
} from "../../data/application";
import {
  codeOfConductError,
  codeOfConductVersion,
} from "../../data/code-of-conduct";
import { createDatabase } from ".";
import { profile, user, volunteerStatus, auditLog } from "./schema";
import { RequestError } from "../http";

const shortAnswer = z.string().trim().min(1).max(200);
const optionalShortAnswer = z.string().trim().max(200).default("");
const longAnswer = z.string().trim().min(1).max(2000);
const phone = z
  .string()
  .trim()
  .min(7)
  .max(40)
  .regex(/^[\d+().\s\-x]+$/i);
const profileAnswersSchema = z.strictObject({
  firstName: shortAnswer,
  middleNames: optionalShortAnswer,
  lastName: shortAnswer,
  preferredName: optionalShortAnswer,
  pronouns: optionalShortAnswer,
  phone,
  birthDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, applicationBirthDateError)
    .refine((value) => {
      const date = new Date(`${value}T00:00:00Z`);
      return (
        !Number.isNaN(date.getTime()) &&
        date.toISOString().slice(0, 10) === value &&
        value >= "1900-01-01" &&
        value <= latestApplicationBirthDate()
      );
    }, applicationBirthDateError),
  emergencyName: shortAnswer,
  emergencyPhone: phone,
  emergencyRelationship: shortAnswer,
  heardAboutUs: optionalShortAnswer,
  heardAboutUsSources: z
    .array(z.enum(heardAboutUsOptions.map((option) => option.value)))
    .min(1, "Select at least one way you found out about us.")
    .max(heardAboutUsOptions.length)
    .refine((values) => new Set(values).size === values.length)
    .transform((values) =>
      heardAboutUsOptions
        .filter((option) => values.includes(option.value))
        .map((option) => option.value),
    ),
  // Only selected Other details are validated/persisted; ignore stale hidden text.
  heardAboutUsOther: z.string().trim().default(""),
  motivation: longAnswer,
  teams: z
    .array(z.enum(["outreach", "medic", "non-patrol"]))
    .max(3)
    .refine((values) => new Set(values).size === values.length)
    .default([])
    .transform(withOutreachTeam),
  certification: z.string().trim().max(200).default(""),
  certifications: z
    .array(
      z.enum([
        ...certificationOptions.map((option) => option.value),
        ...legacyCertificationValues,
      ]),
    )
    .max(certificationOptions.length + legacyCertificationValues.length)
    .refine((values) => new Set(values).size === values.length)
    .default([])
    .transform((values) => {
      const normalized = normalizeCertifications(values);
      return certificationOptions
        .filter((option) => normalized.includes(option.value))
        .map((option) => option.value);
    }),
  experience: z.string().trim().max(2000).default(""),
  training: z
    .array(z.enum(trainingOptions.map((option) => option.value)))
    .max(trainingOptions.length)
    .refine((values) => new Set(values).size === values.length)
    .default([])
    .transform((values) =>
      trainingOptions
        .filter((option) => values.includes(option.value))
        .map((option) => option.value),
    ),
  otherTraining: z.string().trim().max(2000).default(""),
  certificationExpiry: z
    .string()
    .trim()
    .refine((value) => {
      if (!value) return true;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
      const date = new Date(`${value}T00:00:00Z`);
      return (
        !Number.isNaN(date.getTime()) &&
        date.toISOString().slice(0, 10) === value
      );
    }, "Enter a valid certification expiry date.")
    .default(""),
  medicalConditions: z.string().trim().max(2000),
  codeOfConductAccepted: z.boolean().optional(),
});

function validateTraining(
  answers: Pick<
    ApplicationAnswers,
    | "teams"
    | "certifications"
    | "experience"
    | "certificationExpiry"
    | "training"
    | "otherTraining"
  >,
  context: z.RefinementCtx,
) {
  if (answers.training.includes("other") && !answers.otherTraining)
    context.addIssue({
      code: "custom",
      path: ["otherTraining"],
      message: "Describe your other relevant training or experience.",
    });
  if (!answers.teams.includes("medic")) return;
  if (answers.certifications.length !== 1)
    context.addIssue({
      code: "custom",
      path: ["certifications"],
      message: "Select your highest certification or licence.",
    });
  if (answers.certifications.includes("other") && !answers.experience)
    context.addIssue({
      code: "custom",
      path: ["experience"],
      message: "Describe your other training and experience.",
    });
  if (!answers.certificationExpiry)
    context.addIssue({
      code: "custom",
      path: ["certificationExpiry"],
      message: "Enter a valid certification expiry date.",
    });
}

export const profileSchema = profileAnswersSchema.superRefine(
  (answers, context) => {
    validateTraining(answers, context);
    if (
      answers.heardAboutUsSources.includes("other") &&
      (!answers.heardAboutUsOther ||
        answers.heardAboutUsOther.length > heardAboutUsOtherMaxLength)
    )
      context.addIssue({
        code: "custom",
        path: ["heardAboutUsOther"],
        message: `Briefly describe how you found out about us (${heardAboutUsOtherMaxLength} characters or fewer).`,
      });
  },
);

// Older clients may still send these answers; profile edits never replace them.
const profileEditSchema = profileAnswersSchema
  .extend({ firstName: optionalShortAnswer, lastName: optionalShortAnswer })
  .partial({
    heardAboutUs: true,
    heardAboutUsSources: true,
    heardAboutUsOther: true,
    motivation: true,
  })
  .superRefine(validateTraining);

export async function hasApplied(binding: Env["DB"], userId: string) {
  return Boolean(
    await createDatabase(binding).query.profile.findFirst({
      where: eq(profile.user_id, userId),
      columns: { user_id: true },
    }),
  );
}

export async function loadProfile(binding: Env["DB"], userId: string) {
  const row = await createDatabase(binding).query.profile.findFirst({
    where: eq(profile.user_id, userId),
  });
  if (!row) return null;
  return {
    firstName: row.first_name ?? "",
    middleNames: row.middle_names ?? "",
    lastName: row.last_name ?? "",
    preferredName: row.preferred_name,
    pronouns: row.pronouns ?? "",
    phone: row.phone,
    birthDate: row.birth_date,
    emergencyName: row.emergency_contact_name,
    emergencyPhone: row.emergency_contact_phone,
    emergencyRelationship: row.emergency_contact_relationship,
    heardAboutUs: row.heard_about_us,
    heardAboutUsSources: row.heard_about_us_sources ?? [],
    heardAboutUsOther: row.heard_about_us_sources?.includes("other")
      ? (row.heard_about_us_other ?? "")
      : "",
    motivation: row.motivation,
    teams: withOutreachTeam(row.teams),
    certification: row.medical_certification,
    certifications: normalizeCertifications(row.medical_certifications),
    certificationExpiry: row.medical_certification_expiry ?? "",
    experience: row.training_experience,
    training: row.relevant_training,
    otherTraining: row.other_training,
    medicalConditions: row.medical_conditions ?? "",
  } satisfies ApplicationAnswers;
}

export async function saveProfile(
  binding: Env["DB"],
  userId: string,
  input: unknown,
) {
  const old = await loadProfile(binding, userId);
  const submittedInput =
    old && input && typeof input === "object" && !Array.isArray(input)
      ? {
          firstName: old.firstName,
          middleNames: old.middleNames,
          lastName: old.lastName,
          preferredName: old.preferredName,
          pronouns: old.pronouns,
          certification: old.certification,
          certifications: old.certifications,
          experience: old.experience,
          training: old.training,
          otherTraining: old.otherTraining,
          certificationExpiry: old.certificationExpiry,
          ...input,
          // Application-only answers cannot be replaced or block account edits.
          heardAboutUs: undefined,
          heardAboutUsSources: undefined,
          heardAboutUsOther: undefined,
          motivation: undefined,
        }
      : input;
  const parsed = (old ? profileEditSchema : profileSchema).safeParse(
    submittedInput,
  );
  if (!parsed.success)
    throw new RequestError(
      400,
      parsed.error.issues.some((issue) => issue.path[0] === "birthDate")
        ? applicationBirthDateError
        : parsed.error.issues.some((issue) =>
              ["firstName", "lastName"].includes(String(issue.path[0])),
            )
          ? "Enter your first and last names (200 characters or fewer each)."
          : parsed.error.issues.some((issue) =>
                ["heardAboutUsSources", "heardAboutUsOther"].includes(
                  String(issue.path[0]),
                ),
              )
            ? `Select at least one way you found out about us. If you select Other, add a short description (${heardAboutUsOtherMaxLength} characters or fewer).`
            : "Check the required fields, phone numbers, date of birth, team selection, medical certifications, and training answers.",
    );
  const { codeOfConductAccepted, ...submitted } = parsed.data;
  if (!old && codeOfConductAccepted !== true)
    throw new RequestError(400, codeOfConductError);
  const answers: ApplicationAnswers = {
    ...submitted,
    heardAboutUs: old?.heardAboutUs ?? submitted.heardAboutUs!,
    heardAboutUsSources:
      old?.heardAboutUsSources ?? submitted.heardAboutUsSources!,
    heardAboutUsOther:
      old?.heardAboutUsOther ??
      (submitted.heardAboutUsSources!.includes("other")
        ? submitted.heardAboutUsOther!
        : ""),
    motivation: old?.motivation ?? submitted.motivation!,
  };
  // Existing combined-name profiles may stay unsplit. Once components are supplied,
  // require both, and do not allow later edits to erase an established full name.
  if (
    (old?.firstName ||
      old?.middleNames ||
      old?.lastName ||
      answers.firstName ||
      answers.middleNames ||
      answers.lastName) &&
    (!answers.firstName || !answers.lastName)
  )
    throw new RequestError(400, "Enter both your first and last names.");
  if (!applicationDisplayName(answers))
    throw new RequestError(
      400,
      "Enter your first and last names, or keep your previously saved name.",
    );
  const changedFields = (
    Object.keys(answers) as (keyof ApplicationAnswers)[]
  ).filter(
    (key) => JSON.stringify(old?.[key]) !== JSON.stringify(answers[key]),
  );
  if (!changedFields.length) return;
  const db = createDatabase(binding);
  const now = new Date();
  const values = {
    first_name: answers.firstName || null,
    middle_names: answers.middleNames || null,
    last_name: answers.lastName || null,
    preferred_name: answers.preferredName,
    pronouns: answers.pronouns || null,
    phone: answers.phone,
    birth_date: answers.birthDate,
    emergency_contact_name: answers.emergencyName,
    emergency_contact_phone: answers.emergencyPhone,
    emergency_contact_relationship: answers.emergencyRelationship,
    teams: answers.teams,
    medical_certification: answers.certification,
    medical_certifications: answers.certifications,
    medical_certification_expiry: answers.certificationExpiry || null,
    training_experience: answers.experience,
    relevant_training: answers.training,
    other_training: answers.otherTraining,
    medical_conditions: answers.medicalConditions || null,
    updated_at: now,
  };
  // D1 batches are transactions: answers, name, status, and audit succeed together.
  await db.batch([
    db
      .insert(profile)
      .values({
        user_id: userId,
        ...values,
        // Insert-only: preserve legacy text, nullable choices, and saved details on edits.
        heard_about_us: answers.heardAboutUs,
        heard_about_us_sources: answers.heardAboutUsSources,
        heard_about_us_other: answers.heardAboutUsOther || null,
        motivation: answers.motivation,
        code_of_conduct_version: codeOfConductVersion,
        code_of_conduct_accepted_at: now,
        registered_at: now,
      })
      .onConflictDoUpdate({ target: profile.user_id, set: values }),
    db
      .update(user)
      .set({ name: applicationDisplayName(answers), updated_at: now })
      .where(eq(user.id, userId)),
    // Existing approval and active status are deliberately not overwritten.
    db
      .insert(volunteerStatus)
      .values({ user_id: userId, updated_at: now })
      .onConflictDoNothing(),
    db.insert(auditLog).values({
      id: crypto.randomUUID(),
      actor_id: userId,
      subject_id: userId,
      action: "profile_updated",
      changed_fields: changedFields,
      created_at: now,
    }),
  ]);
}
