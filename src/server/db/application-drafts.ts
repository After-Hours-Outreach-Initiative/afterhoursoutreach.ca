import { eq } from "drizzle-orm";
import {
  applicationDraftSchema,
  applicationDraftWriteSchema,
  applicationDraftDiscardSchema,
  type ApplicationDraft,
} from "../../data/application-draft";
import { createDatabase } from ".";
import { applicationDraft, applicationDraftGeneration, user } from "./schema";
import { permissionValues, writePermission, type Actor } from "./access";
import { hasApplied } from "./profiles";
import { RequestError } from "../http";
import { mergeAnswers } from "../../data/answer-merge";

export async function loadApplicationDraftState(
  binding: Env["DB"],
  userId: string,
) {
  const [state] = await createDatabase(binding)
    .select({
      draft: applicationDraft,
      generation: applicationDraftGeneration.generation,
    })
    .from(user)
    .leftJoin(applicationDraft, eq(applicationDraft.user_id, user.id))
    .leftJoin(
      applicationDraftGeneration,
      eq(applicationDraftGeneration.user_id, user.id),
    )
    .where(eq(user.id, userId));
  const row = state?.draft;
  const generation = state?.generation ?? null;
  const draft: ApplicationDraft | null = row
    ? applicationDraftSchema.parse({
        version: row.version,
        revision: row.revision,
        generation,
        answers: row.answers,
        updatedAt: row.updated_at.getTime(),
      })
    : null;
  return { draft, generation };
}

export async function loadApplicationDraft(binding: Env["DB"], userId: string) {
  return (await loadApplicationDraftState(binding, userId)).draft;
}

export async function saveApplicationDraft(
  binding: Env["DB"],
  actor: Actor,
  input: unknown,
): Promise<ApplicationDraft> {
  const parsed = applicationDraftWriteSchema.safeParse(input);
  if (!parsed.success)
    throw new RequestError(400, "Check the application draft answers.");
  const { userId, generation, baseline } = parsed.data;
  // An old tab must not save its answers to a newly signed-in account.
  if (userId !== actor.id)
    throw new RequestError(
      403,
      "Your account changed. Reload before continuing.",
    );
  for (let attempt = 0; attempt < 4; attempt++) {
    const state = await loadApplicationDraftState(binding, actor.id);
    let previous = parsed.data.revision;
    let answers = parsed.data.answers;
    // Never rebase across a discard, including an initially absent draft.
    if (state.generation !== generation)
      throw new RequestError(
        409,
        "Your draft was discarded. Reload before continuing.",
      );
    if (previous !== (state.draft?.revision ?? null) && baseline) {
      const merged = mergeAnswers(
        baseline,
        answers,
        state.draft?.answers ??
          applicationDraftWriteSchema.shape.answers.parse({}),
      );
      if (merged.conflicts.length)
        throw new RequestError(
          409,
          "Choose which answers to keep for the conflicting fields.",
          { draft: state.draft, conflicts: merged.conflicts },
        );
      answers = merged.answers;
      previous = state.draft?.revision ?? null;
    }
    const revision = crypto.randomUUID();
    const updatedAt = Date.now();
    const saved = await binding
      .prepare(
        `INSERT INTO application_draft (user_id, version, revision, answers, updated_at)
       SELECT ?, 1, ?, ?, ?
       WHERE NOT EXISTS (SELECT 1 FROM profile WHERE user_id=?)
       AND ${writePermission()}
       AND (? IS NULL OR EXISTS (SELECT 1 FROM application_draft WHERE user_id=? AND revision=?))
       AND (SELECT generation FROM application_draft_generation WHERE user_id=?) IS ?
       ON CONFLICT(user_id) DO UPDATE SET
         revision=excluded.revision, answers=excluded.answers, updated_at=excluded.updated_at
       WHERE application_draft.revision=?
       RETURNING revision`,
      )
      .bind(
        actor.id,
        revision,
        JSON.stringify(answers),
        updatedAt,
        actor.id,
        ...permissionValues(actor),
        previous,
        actor.id,
        previous,
        actor.id,
        generation,
        previous,
      )
      .first();
    if (!saved) {
      const permitted = await binding
        .prepare(`SELECT 1 WHERE ${writePermission()}`)
        .bind(...permissionValues(actor))
        .first();
      if (!permitted)
        throw new RequestError(401, "Sign in to save your draft.");
      if (await hasApplied(binding, actor.id))
        throw new RequestError(
          410,
          "Your application has already been submitted.",
        );
      if (baseline && attempt < 3) continue;
      throw new RequestError(
        409,
        "Your draft changed on another tab or device. Choose which answers to keep.",
      );
    }
    return { version: 1, revision, generation, answers, updatedAt };
  }
  throw new RequestError(409, "Your draft is changing. Retry saving.");
}

export async function discardApplicationDraft(
  binding: Env["DB"],
  actor: Actor,
  input: unknown,
) {
  const parsed = applicationDraftDiscardSchema.safeParse(input);
  if (!parsed.success)
    throw new RequestError(400, "Check the draft discard request.");
  const { userId, generation, discardId } = parsed.data;
  if (userId !== actor.id)
    throw new RequestError(
      403,
      "Your account changed. Reload before continuing.",
    );
  // Keep only concurrency metadata, never the discarded answers. Recheck the
  // session inside the same atomic statement as the destructive write.
  const result = await binding
    .prepare(
      `INSERT INTO application_draft_generation (user_id, generation)
     SELECT ?, ? WHERE ${writePermission()}
     AND NOT EXISTS (SELECT 1 FROM profile WHERE user_id=?)
     AND (SELECT generation FROM application_draft_generation WHERE user_id=?) IS ?
     ON CONFLICT(user_id) DO UPDATE SET
       generation=excluded.generation
     WHERE application_draft_generation.generation IS NOT ?
     RETURNING generation`,
    )
    .bind(
      actor.id,
      discardId,
      ...permissionValues(actor),
      actor.id,
      actor.id,
      generation,
      discardId,
    )
    .first();
  if (!result) {
    const permitted = await binding
      .prepare(`SELECT 1 WHERE ${writePermission()}`)
      .bind(...permissionValues(actor))
      .first();
    if (!permitted)
      throw new RequestError(
        401,
        "Sign in with your authenticator to discard your draft.",
      );
    if (await hasApplied(binding, actor.id))
      throw new RequestError(
        410,
        "Your submitted application has not been changed.",
      );
    const state = await loadApplicationDraftState(binding, actor.id);
    // A lost success response may be retried, but must not erase newer answers.
    if (state.generation !== discardId || state.draft)
      throw new RequestError(
        409,
        "Your draft changed. Reload to check before discarding again.",
      );
  }
  return { userId: actor.id, generation: discardId };
}
