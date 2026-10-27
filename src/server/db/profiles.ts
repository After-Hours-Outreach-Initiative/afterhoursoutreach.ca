import { eq } from "drizzle-orm";
import { z } from "zod";
import {
  savedTeamOptions,
  certificationOptions,
  legacyCertificationValues,
  isValidApplicationBirthDate,
  normalizeCertifications,
  applicationBirthDateError,
  outreachRequiredError,
  trainingOptions,
  trainingRequiredError,
  trainingExclusiveError,
  experienceOptions,
  experienceRequiredError,
  experienceExclusiveError,
  normalizeTrainingAnswers,
  otherTrainingMaxLength,
  applicationDisplayName,
  heardAboutUsOptions,
  heardAboutUsOtherMaxLength,
  countWords,
  motivationMaxWords,
  motivationWordLimitError,
  profileReadOnlyFields,
  type ApplicationAnswers,
  type SubmittedApplication,
} from "../../data/application";
import {
  codeOfConductError,
  codeOfConductVersion,
} from "../../data/code-of-conduct";
import { createDatabase } from ".";
import { profile, event, orientationCompletion } from "./schema";
import { RequestError } from "../http";
import { mergeAnswers } from "../../data/answer-merge";
import { permissionValues, writePermission, type Actor } from "./access";

export interface ProfileSaveOptions {
  intent?: "submit" | "edit";
  baseline?: ApplicationAnswers;
  draft?: { revision: string | null; generation: string | null };
  actor?: Actor;
  /** Append durable first-submission intents to this transaction, gated by writeGuard.
   * The guard is true only for the winning first insert, never for retries.
   * writeGuard has one SQL placeholder: bind operationId at that position.
   * Read profile.submitted_application in the INSERT SELECT for the immutable
   * answers and captured account email, rather than loading a recipient later.
   * Use parameterized statements; do not send email from this callback.
   */
  firstSubmissionStatements?: (context: {
    userId: string;
    operationId: string;
    writeGuard: string;
    submission: Omit<SubmittedApplication, "email">;
  }) => D1PreparedStatement[];
}

export interface ProfileSaveResult {
  /** True only when this call atomically inserted the first profile. */
  firstSubmitted: boolean;
  alreadySubmitted?: boolean;
  answers: ApplicationAnswers;
  operationId?: string;
}

const shortAnswer = z.string().trim().min(1).max(200);
const optionalShortAnswer = z.string().trim().max(200).default("");
const nameFields = ["firstName", "middleNames", "lastName"] as const;
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
    .refine(isValidApplicationBirthDate, applicationBirthDateError),
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
  // The API's bounded JSON reader protects request size; this limit is in words.
  motivation: z
    .string()
    .trim()
    .min(1, "This field is required.")
    .refine(
      (value) => countWords(value) <= motivationMaxWords,
      motivationWordLimitError,
    ),
  teams: z
    .array(z.enum(savedTeamOptions.map((option) => option.value)))
    .max(savedTeamOptions.length)
    .refine((values) => new Set(values).size === values.length)
    .default([]),
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
    .refine(
      (values) => !values.includes("none") || values.length === 1,
      trainingExclusiveError,
    )
    .default([])
    .transform((values) =>
      trainingOptions
        .filter((option) => values.includes(option.value))
        .map((option) => option.value),
    ),
  otherTraining: z.string().trim().max(otherTrainingMaxLength).default(""),
  relevantExperience: z
    .array(z.enum(experienceOptions.map((option) => option.value)))
    .max(experienceOptions.length)
    .refine((values) => new Set(values).size === values.length)
    .refine(
      (values) => !values.includes("none") || values.length === 1,
      experienceExclusiveError,
    )
    .default([])
    .transform((values) =>
      experienceOptions
        .filter((option) => values.includes(option.value))
        .map((option) => option.value),
    ),
  otherExperience: z.string().trim().max(2000).default(""),
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
    | "relevantExperience"
    | "otherExperience"
  >,
  context: z.RefinementCtx,
  requireTraining = true,
  requireExperience = true,
) {
  if (requireTraining && !answers.training.length)
    context.addIssue({
      code: "custom",
      path: ["training"],
      message: trainingRequiredError,
    });
  if (answers.training.includes("other") && !answers.otherTraining)
    context.addIssue({
      code: "custom",
      path: ["otherTraining"],
      message: "Describe your other relevant training.",
    });
  if (requireExperience && !answers.relevantExperience.length)
    context.addIssue({
      code: "custom",
      path: ["relevantExperience"],
      message: experienceRequiredError,
    });
  if (answers.relevantExperience.includes("other") && !answers.otherExperience)
    context.addIssue({
      code: "custom",
      path: ["otherExperience"],
      message: "Describe your other relevant experience.",
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

const requiredTeams = profileAnswersSchema.shape.teams.refine(
  (teams) => teams.includes("outreach"),
  outreachRequiredError,
);

export const profileSchema = profileAnswersSchema
  .extend({ teams: requiredTeams })
  .superRefine((answers, context) => {
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
  });

// Older clients may still send application-only answers; edits never replace them.
const profileEditSchema = profileAnswersSchema
  // Unchanged legacy names and birthdays stay verbatim. Validate changed names below.
  .extend({
    firstName: z.string(),
    middleNames: z.string(),
    lastName: z.string(),
    birthDate: z.string(),
  })
  .partial({
    heardAboutUs: true,
    heardAboutUsSources: true,
    heardAboutUsOther: true,
    motivation: true,
  });

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
    teams: row.teams,
    certification: row.medical_certification,
    certifications: normalizeCertifications(row.medical_certifications),
    certificationExpiry: row.medical_certification_expiry ?? "",
    experience: row.training_experience,
    ...normalizeTrainingAnswers({
      training: row.relevant_training,
      otherTraining: row.other_training,
      relevantExperience: row.relevant_experience,
      otherExperience: row.other_experience,
    }),
    medicalConditions: row.medical_conditions ?? "",
  } satisfies ApplicationAnswers;
}

export async function loadSubmittedApplication(
  binding: Env["DB"],
  userId: string,
) {
  const row = await createDatabase(binding).query.profile.findFirst({
    where: eq(profile.user_id, userId),
    columns: { submitted_application: true },
  });
  return row?.submitted_application ?? null;
}

export async function loadFirstCompletedOrientation(
  binding: Env["DB"],
  userId: string,
) {
  const row = await createDatabase(binding)
    .select({ startsAt: event.starts_at })
    .from(orientationCompletion)
    .innerJoin(event, eq(event.id, orientationCompletion.event_id))
    .where(eq(orientationCompletion.user_id, userId))
    .orderBy(event.starts_at)
    .limit(1)
    .get();
  return row?.startsAt ?? null;
}

export async function saveProfile(
  binding: Env["DB"],
  userId: string,
  input: unknown,
  options: ProfileSaveOptions = {},
): Promise<ProfileSaveResult> {
  // Older open forms/baselines still use the combined question.
  if (
    input &&
    typeof input === "object" &&
    !Array.isArray(input) &&
    "training" in input &&
    Array.isArray(input.training) &&
    input.training.every((value) => typeof value === "string") &&
    new Set(input.training).size === input.training.length &&
    !("relevantExperience" in input) &&
    (!("otherTraining" in input) || typeof input.otherTraining === "string")
  )
    input = normalizeTrainingAnswers(
      input as { training: string[]; otherTraining?: string },
    );
  let baseline = options.baseline;
  if (baseline && baseline.relevantExperience === undefined) {
    if (
      !Array.isArray(baseline.training) ||
      !baseline.training.every((value) => typeof value === "string") ||
      typeof baseline.otherTraining !== "string"
    )
      throw new RequestError(
        400,
        "Reload this page before saving profile changes.",
      );
    baseline = normalizeTrainingAnswers(baseline);
  }
  if (options.actor && options.actor.id !== userId)
    throw new RequestError(
      403,
      "Your account changed. Reload before continuing.",
    );
  for (let attempt = 0; attempt < 4; attempt++) {
    const row = await createDatabase(binding).query.profile.findFirst({
      where: eq(profile.user_id, userId),
      columns: { updated_at: true },
    });
    const old = await loadProfile(binding, userId);
    // A submission is never a profile update. A concurrent first submission or a
    // lost-response retry must not replace even the mutable profile answers.
    const intent =
      options.intent ??
      (input &&
      typeof input === "object" &&
      "codeOfConductAccepted" in input &&
      input.codeOfConductAccepted === true
        ? "submit"
        : old
          ? "edit"
          : "submit");
    if (old && intent === "submit")
      return { firstSubmitted: false, alreadySubmitted: true, answers: old };
    if (!old && intent === "edit")
      throw new RequestError(409, "Reload before editing your profile.");
    if (old && !options.baseline)
      throw new RequestError(
        428,
        "Reload this page before saving profile changes.",
      );
    if (old && input && typeof input === "object" && !Array.isArray(input)) {
      const submitted = input as Record<string, unknown>;
      for (const field of profileReadOnlyFields)
        if (field in submitted && submitted[field] !== old[field])
          throw new RequestError(
            400,
            "Your date of birth cannot be changed from your account.",
          );
    }
    let submittedInput =
      old && input && typeof input === "object" && !Array.isArray(input)
        ? {
            firstName: old.firstName,
            middleNames: old.middleNames,
            lastName: old.lastName,
            birthDate: old.birthDate,
            preferredName: old.preferredName,
            pronouns: old.pronouns,
            teams: old.teams,
            certification: old.certification,
            certifications: old.certifications,
            experience: old.experience,
            training: old.training,
            otherTraining: old.otherTraining,
            relevantExperience: old.relevantExperience,
            otherExperience: old.otherExperience,
            certificationExpiry: old.certificationExpiry,
            ...input,
            // Application-only answers cannot be replaced or block account edits.
            heardAboutUs: undefined,
            heardAboutUsSources: undefined,
            heardAboutUsOther: undefined,
            motivation: undefined,
          }
        : input;
    if (
      old &&
      baseline &&
      submittedInput &&
      typeof submittedInput === "object"
    ) {
      // The baseline is concurrency metadata, not a new source of profile data.
      for (const key of Object.keys(old) as (keyof ApplicationAnswers)[]) {
        const value = baseline[key];
        if (
          Array.isArray(old[key])
            ? !Array.isArray(value) ||
              !value.every((item) => typeof item === "string")
            : typeof value !== "string"
        )
          throw new RequestError(
            400,
            "Reload this page before saving profile changes.",
          );
      }
      const local = { ...old, ...submittedInput } as ApplicationAnswers;
      const immutableFields = [
        ...profileReadOnlyFields,
        "heardAboutUs",
        "heardAboutUsSources",
        "heardAboutUsOther",
        "motivation",
      ] as const;
      // Compare the same values validation persists. An identical lost-response
      // retry with surrounding whitespace/legacy certification aliases is not
      // a second same-field edit against the normalized successful write.
      for (const key of Object.keys(old) as (keyof ApplicationAnswers)[])
        if (
          !immutableFields.some((field) => field === key) &&
          !(
            nameFields.some((field) => field === key) && local[key] === old[key]
          ) &&
          typeof local[key] === "string"
        )
          Object.assign(local, { [key]: (local[key] as string).trim() });
      const certifications =
        profileAnswersSchema.shape.certifications.safeParse(
          local.certifications,
        );
      if (certifications.success) local.certifications = certifications.data;
      for (const key of immutableFields)
        Object.assign(local, { [key]: old[key] });
      const merged = mergeAnswers(baseline, local, old);
      if (merged.conflicts.length)
        throw new RequestError(
          409,
          "Your profile changed on another device. Choose which conflicting answers to keep.",
          { latest: old, conflicts: merged.conflicts },
        );
      submittedInput = {
        ...merged.answers,
        heardAboutUs: undefined,
        heardAboutUsSources: undefined,
        heardAboutUsOther: undefined,
        motivation: undefined,
      };
    }
    const namesChanged =
      !old ||
      nameFields.some(
        (field) =>
          (submittedInput as Record<string, unknown>)?.[field] !== old[field],
      );
    const schema = old
      ? profileEditSchema
          .extend({
            firstName: namesChanged
              ? profileAnswersSchema.shape.firstName
              : profileEditSchema.shape.firstName,
            middleNames: namesChanged
              ? profileAnswersSchema.shape.middleNames
              : profileEditSchema.shape.middleNames,
            lastName: namesChanged
              ? profileAnswersSchema.shape.lastName
              : profileEditSchema.shape.lastName,
            // Keep Outreach on submitted profiles, but don't impose a new answer on
            // legacy profiles that never selected it or invent it during an edit.
            teams: old.teams.includes("outreach")
              ? requiredTeams
              : profileAnswersSchema.shape.teams,
          })
          .superRefine((answers, context) =>
            // Leave unanswered legacy profiles editable without inventing an answer.
            validateTraining(
              answers,
              context,
              old.training.length > 0,
              old.relevantExperience.length > 0,
            ),
          )
      : profileSchema;
    const parsed = schema.safeParse(submittedInput);
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
              : parsed.error.issues.some(
                    (issue) => issue.path[0] === "motivation",
                  )
                ? `Explain why you want to volunteer (${motivationMaxWords} words or fewer).`
                : (parsed.error.issues.find((issue) =>
                    [
                      "teams",
                      "training",
                      "relevantExperience",
                      "otherTraining",
                      "otherExperience",
                    ].includes(String(issue.path[0])),
                  )?.message ??
                  "Check the required fields, phone numbers, date of birth, team selection, medical certifications, and training and experience answers."),
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
    if (!applicationDisplayName(answers))
      throw new RequestError(400, "Enter a preferred name.");
    const changedFields = (
      Object.keys(answers) as (keyof ApplicationAnswers)[]
    ).filter(
      (key) => JSON.stringify(old?.[key]) !== JSON.stringify(answers[key]),
    );
    if (!changedFields.length) return { firstSubmitted: false, answers };
    const now = new Date(
      Math.max(Date.now(), (row?.updated_at.getTime() ?? 0) + 1),
    );
    const submission = {
      version: 1,
      answers,
      submittedAt: now.toISOString(),
      codeOfConductVersion,
      codeOfConductAcceptedAt: now.toISOString(),
    } satisfies Omit<SubmittedApplication, "email">;
    const values = {
      // Do not split or normalize untouched legacy names on unrelated edits.
      ...(namesChanged && {
        first_name: answers.firstName || null,
        middle_names: answers.middleNames || null,
        last_name: answers.lastName || null,
      }),
      preferred_name: answers.preferredName,
      pronouns: answers.pronouns || null,
      phone: answers.phone,
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
      relevant_experience: answers.relevantExperience,
      other_experience: answers.otherExperience,
      medical_conditions: answers.medicalConditions || null,
      updated_at: now,
    };
    const insertValues = {
      user_id: userId,
      ...values,
      // Date of birth remains insert-only.
      birth_date: answers.birthDate,
      // Insert-only: preserve legacy text, nullable choices, and saved details on edits.
      heard_about_us: answers.heardAboutUs,
      heard_about_us_sources: answers.heardAboutUsSources,
      heard_about_us_other: answers.heardAboutUsOther || null,
      motivation: answers.motivation,
      code_of_conduct_version: codeOfConductVersion,
      code_of_conduct_accepted_at: now,
      // Capture the account email in the same write as the answers. On conflict,
      // neither replace a snapshot nor backfill a legacy profile from edits.
      submitted_application: JSON.stringify(submission),
      registered_at: now,
    };
    const encode = (value: unknown): string | number | null =>
      value instanceof Date
        ? value.getTime()
        : Array.isArray(value)
          ? JSON.stringify(value)
          : (value as string | number | null);
    const permission = options.actor ? writePermission() : "1";
    const permissions = options.actor ? permissionValues(options.actor) : [];
    const entries = Object.entries(old ? values : insertValues);
    const draftGuard =
      !old && options.draft
        ? "AND (SELECT generation FROM application_draft_generation WHERE user_id=?) IS ? AND (SELECT revision FROM application_draft WHERE user_id=?) IS ?"
        : "";
    const draftParams =
      !old && options.draft
        ? [userId, options.draft.generation, userId, options.draft.revision]
        : [];
    const write = old
      ? binding
          .prepare(
            `UPDATE profile SET ${entries.map(([key]) => `${key}=?`).join(",")} WHERE user_id=? AND updated_at=? AND ${permission} RETURNING user_id`,
          )
          .bind(
            ...entries.map(([, value]) => encode(value)),
            userId,
            row?.updated_at.getTime() ?? -1,
            ...permissions,
          )
      : binding
          .prepare(
            `INSERT INTO profile (${entries.map(([key]) => key).join(",")}) SELECT ${entries.map(([key]) => (key === "submitted_application" ? "json_set(?, '$.email', (SELECT email FROM user WHERE id=?))" : "?")).join(",")} WHERE ${permission} ${draftGuard} ON CONFLICT(user_id) DO NOTHING RETURNING user_id`,
          )
          .bind(
            ...entries.flatMap(([key, value]) =>
              key === "submitted_application"
                ? [encode(value), userId]
                : [encode(value)],
            ),
            ...permissions,
            ...draftParams,
          );
    const operationId = crypto.randomUUID();
    // changes() refers to the immediately preceding profile write. The audit ID
    // then gates every other effect, so losing CAS/insert attempts do nothing.
    const writeGuard = "EXISTS (SELECT 1 FROM audit_log WHERE id=?)";
    const results = await binding.batch([
      write,
      binding
        .prepare(
          "INSERT INTO audit_log (id,actor_id,subject_id,action,changed_fields,created_at) SELECT ?,?,?,'profile_updated',?,? WHERE changes()=1",
        )
        .bind(
          operationId,
          userId,
          userId,
          JSON.stringify(changedFields),
          now.getTime(),
        ),
      binding
        .prepare(
          `UPDATE user SET name=?,updated_at=? WHERE id=? AND ${writeGuard}`,
        )
        .bind(
          applicationDisplayName(answers),
          now.getTime(),
          userId,
          operationId,
        ),
      binding
        .prepare(
          `INSERT INTO volunteer_status (user_id,updated_at) SELECT ?,? WHERE ${writeGuard} ON CONFLICT DO NOTHING`,
        )
        .bind(userId, now.getTime(), operationId),
      binding
        .prepare(
          `DELETE FROM application_draft WHERE user_id=? AND ${writeGuard}`,
        )
        .bind(userId, operationId),
      ...(!old
        ? (options.firstSubmissionStatements?.({
            userId,
            operationId,
            writeGuard,
            submission,
          }) ?? [])
        : []),
    ]);
    if (results[0].results.length)
      return { firstSubmitted: !old, answers, operationId };
    if (
      options.actor &&
      !(await binding
        .prepare(`SELECT 1 WHERE ${writePermission()}`)
        .bind(...permissionValues(options.actor))
        .first())
    )
      throw new RequestError(401, "Sign in again before saving your profile.");
    if (!old && options.draft && !(await hasApplied(binding, userId)))
      throw new RequestError(
        409,
        "Your draft changed or was discarded. Check your saved answers before submitting.",
        { draftChanged: true },
      );
  }
  throw new RequestError(
    409,
    "Your profile is changing. Retry saving; your input has been kept.",
  );
}
