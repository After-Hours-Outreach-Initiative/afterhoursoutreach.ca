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
const longAnswer = z.string().trim().min(1).max(2000);
const phone = z
  .string()
  .trim()
  .min(7)
  .max(40)
  .regex(/^[\d+().\s\-x]+$/i);
const profileAnswersSchema = z.strictObject({
  name: shortAnswer,
  pronouns: z.string().trim().max(200),
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
  heardAboutUs: shortAnswer,
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

export const profileSchema = profileAnswersSchema.superRefine(validateTraining);

// Older clients may still send these answers; profile edits never replace them.
const profileEditSchema = profileAnswersSchema
  .partial({
    heardAboutUs: true,
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
    name: row.preferred_name,
    pronouns: row.pronouns ?? "",
    phone: row.phone,
    birthDate: row.birth_date,
    emergencyName: row.emergency_contact_name,
    emergencyPhone: row.emergency_contact_phone,
    emergencyRelationship: row.emergency_contact_relationship,
    heardAboutUs: row.heard_about_us,
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
          certification: old.certification,
          certifications: old.certifications,
          experience: old.experience,
          training: old.training,
          otherTraining: old.otherTraining,
          certificationExpiry: old.certificationExpiry,
          ...input,
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
        : "Check the required fields, phone numbers, date of birth, team selection, medical certifications, and training answers.",
    );
  const { codeOfConductAccepted, ...submitted } = parsed.data;
  if (!old && codeOfConductAccepted !== true)
    throw new RequestError(400, codeOfConductError);
  const answers: ApplicationAnswers = {
    ...submitted,
    heardAboutUs: old?.heardAboutUs ?? submitted.heardAboutUs!,
    motivation: old?.motivation ?? submitted.motivation!,
  };
  const changedFields = (
    Object.keys(answers) as (keyof ApplicationAnswers)[]
  ).filter(
    (key) => JSON.stringify(old?.[key]) !== JSON.stringify(answers[key]),
  );
  if (!changedFields.length) return;
  const db = createDatabase(binding);
  const now = new Date();
  const values = {
    preferred_name: answers.name,
    pronouns: answers.pronouns || null,
    phone: answers.phone,
    birth_date: answers.birthDate,
    emergency_contact_name: answers.emergencyName,
    emergency_contact_phone: answers.emergencyPhone,
    emergency_contact_relationship: answers.emergencyRelationship,
    heard_about_us: answers.heardAboutUs,
    motivation: answers.motivation,
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
        code_of_conduct_version: codeOfConductVersion,
        code_of_conduct_accepted_at: now,
        registered_at: now,
      })
      .onConflictDoUpdate({ target: profile.user_id, set: values }),
    db
      .update(user)
      .set({ name: answers.name, updated_at: now })
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
