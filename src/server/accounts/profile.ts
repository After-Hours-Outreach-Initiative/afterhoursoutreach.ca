import { eq } from "drizzle-orm";
import { z } from "zod";
import type { RegistrationAnswers } from "../../data/registration";
import { createDatabase } from "../db";
import { profile, user, volunteerStatus, auditLog } from "../db/schema";
import { RequestError } from "../http";

const shortAnswer = z.string().trim().min(1).max(200);
const longAnswer = z.string().trim().min(1).max(2000);
const phone = z
  .string()
  .trim()
  .min(7)
  .max(40)
  .regex(/^[\d+().\s\-x]+$/i);
export const profileSchema = z.strictObject({
  name: shortAnswer,
  pronouns: z.string().trim().max(200),
  phone,
  birthDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .refine((value) => {
      const date = new Date(`${value}T00:00:00Z`);
      return (
        !Number.isNaN(date.getTime()) &&
        date.toISOString().slice(0, 10) === value &&
        value >= "1900-01-01" &&
        value <= new Date().toISOString().slice(0, 10)
      );
    }, "Choose a valid date of birth."),
  emergencyName: shortAnswer,
  emergencyPhone: phone,
  emergencyRelationship: shortAnswer,
  heardAboutUs: shortAnswer,
  motivation: longAnswer,
  teams: z
    .array(z.enum(["outreach", "medic", "non-patrol"]))
    .min(1)
    .max(3)
    .refine((values) => new Set(values).size === values.length),
  certification: shortAnswer,
  experience: longAnswer,
  medicalConditions: z.string().trim().max(2000),
});

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
    teams: row.teams,
    certification: row.medical_certification,
    experience: row.training_experience,
    medicalConditions: row.medical_conditions ?? "",
  } satisfies RegistrationAnswers;
}

export async function saveProfile(
  binding: Env["DB"],
  userId: string,
  input: unknown,
) {
  const parsed = profileSchema.safeParse(input);
  if (!parsed.success)
    throw new RequestError(
      400,
      "Check the required fields, phone numbers, date of birth, and team selection.",
    );
  const answers = parsed.data;
  const old = await loadProfile(binding, userId);
  const changedFields = (
    Object.keys(answers) as (keyof RegistrationAnswers)[]
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
    training_experience: answers.experience,
    medical_conditions: answers.medicalConditions || null,
    updated_at: now,
  };
  // D1 batches are transactions: answers, name, status, and audit succeed together.
  await db.batch([
    db
      .insert(profile)
      .values({ user_id: userId, ...values, registered_at: now })
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
