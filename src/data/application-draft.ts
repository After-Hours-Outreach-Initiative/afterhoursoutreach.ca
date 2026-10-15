import { z } from "zod";
import {
  applicationTeamOptions,
  certificationOptions,
  heardAboutUsOptions,
  trainingOptions,
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

export const applicationDraftAnswersSchema = z.strictObject({
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
  teams: choices(applicationTeamOptions).default(["outreach"]),
  certifications: choices(certificationOptions),
  certificationExpiry: text(),
  experience: text(2000),
  training: choices(trainingOptions),
  otherTraining: text(2000),
  medicalConditions: text(2000),
});

export type ApplicationDraftAnswers = z.infer<
  typeof applicationDraftAnswersSchema
>;

export const applicationDraftSchema = z.strictObject({
  version: z.literal(1),
  revision: z.uuid(),
  answers: applicationDraftAnswersSchema,
  updatedAt: z.number().int().nonnegative(),
});
export type ApplicationDraft = z.infer<typeof applicationDraftSchema>;

export const applicationDraftWriteSchema = z.strictObject({
  userId: z.string().min(1).max(200),
  version: z.literal(1),
  revision: z.uuid().nullable(),
  answers: applicationDraftAnswersSchema,
});

export const localApplicationDraftSchema = z.strictObject({
  version: z.literal(1),
  revision: z.uuid().nullable(),
  answers: applicationDraftAnswersSchema,
  savedAnswers: applicationDraftAnswersSchema,
});

export const applicationDraftBodyLimit = 65_536;
export const applicationDraftStoragePrefix = "aho:application-draft:v1:";

export const applicationDraftReadResponseSchema = z.strictObject({
  userId: z.string(),
  submitted: z.boolean(),
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
