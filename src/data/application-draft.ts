import { z } from "zod";
import {
  savedTeamOptions,
  certificationOptions,
  heardAboutUsOptions,
  trainingOptions,
  trainingExclusiveError,
  experienceOptions,
  experienceExclusiveError,
  normalizeTrainingAnswers,
  otherTrainingMaxLength,
  type ApplicationAnswers,
} from "./application";

// Drafts preserve unfinished/invalid answers, not submission validation or consent.
const text = (max = 200) => z.string().max(max).default("");
const choices = (options: readonly { value: string }[]) =>
  z
    .array(z.enum(options.map((option) => option.value)))
    .max(options.length)
    .refine((values) => new Set(values).size === values.length)
    .default([]);

export const applicationDraftAnswersSchema = z.preprocess(
  (input) => {
    if (!input || typeof input !== "object" || Array.isArray(input))
      return input;
    const answers = input as Record<string, unknown>;
    if (
      answers.relevantExperience !== undefined ||
      (answers.training !== undefined &&
        (!Array.isArray(answers.training) ||
          !answers.training.every((value) => typeof value === "string") ||
          new Set(answers.training).size !== answers.training.length)) ||
      (answers.otherTraining !== undefined &&
        typeof answers.otherTraining !== "string")
    )
      return input;
    return normalizeTrainingAnswers(
      answers as { training?: string[]; otherTraining?: string },
    );
  },
  z.strictObject({
    firstName: text(),
    middleNames: text(),
    lastName: text(),
    preferredName: text(),
    pronouns: text(),
    phone: text(),
    birthDate: text(),
    emergencyName: text(),
    emergencyPhone: text(),
    emergencyRelationship: text(),
    heardAboutUsSources: choices(heardAboutUsOptions),
    heardAboutUsOther: text(),
    motivation: text(16_384),
    teams: choices(savedTeamOptions),
    certifications: choices(certificationOptions),
    certificationExpiry: text(),
    experience: text(2000),
    training: choices(trainingOptions).refine(
      (values) => !values.includes("none") || values.length === 1,
      trainingExclusiveError,
    ),
    otherTraining: text(otherTrainingMaxLength),
    relevantExperience: choices(experienceOptions).refine(
      (values) => !values.includes("none") || values.length === 1,
      experienceExclusiveError,
    ),
    otherExperience: text(2000),
    medicalConditions: text(2000),
  }),
);

export type ApplicationDraftAnswers = z.infer<
  typeof applicationDraftAnswersSchema
>;

export const applicationDraftSchema = z.strictObject({
  version: z.literal(1),
  revision: z.uuid(),
  generation: z.uuid().nullable().default(null),
  answers: applicationDraftAnswersSchema,
  updatedAt: z.number().int().nonnegative(),
});
export type ApplicationDraft = z.infer<typeof applicationDraftSchema>;

export const applicationDraftWriteSchema = z.strictObject({
  userId: z.string().min(1).max(200),
  version: z.literal(1),
  revision: z.uuid().nullable(),
  generation: z.uuid().nullable().default(null),
  answers: applicationDraftAnswersSchema,
  baseline: applicationDraftAnswersSchema.optional(),
});

export const localApplicationDraftSchema = z.strictObject({
  version: z.literal(1),
  revision: z.uuid().nullable(),
  generation: z.uuid().nullable().default(null),
  answers: applicationDraftAnswersSchema,
  savedAnswers: applicationDraftAnswersSchema,
});

export const applicationDraftBodyLimit = 65_536;
export const applicationDraftStoragePrefix = "aho:application-draft:v1:";
export const applicationDraftDiscardPrefix =
  "aho:application-draft-discard:v1:";
export const applicationDraftDiscardSchema = z.strictObject({
  userId: z.string().min(1).max(200),
  generation: z.uuid().nullable(),
  discardId: z.uuid(),
});
export const localDraftDiscardSchema = applicationDraftDiscardSchema.extend({
  completed: z.boolean(),
});
export const applicationDraftDiscardResponseSchema = z.strictObject({
  userId: z.string(),
  generation: z.uuid(),
});

export const applicationDraftReadResponseSchema = z.strictObject({
  userId: z.string(),
  submitted: z.boolean(),
  generation: z.uuid().nullable(),
  draft: applicationDraftSchema.nullable(),
});
export const applicationDraftSaveResponseSchema = z.strictObject({
  userId: z.string(),
  draft: applicationDraftSchema,
});

export function draftProfileValues(
  answers: ApplicationDraftAnswers,
): ApplicationAnswers {
  return { ...answers, heardAboutUs: "", certification: "" };
}

export function sameDraftAnswers(
  left: ApplicationDraftAnswers,
  right: ApplicationDraftAnswers,
) {
  return JSON.stringify(left) === JSON.stringify(right);
}
