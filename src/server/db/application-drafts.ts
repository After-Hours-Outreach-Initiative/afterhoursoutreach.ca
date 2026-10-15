import { eq } from "drizzle-orm";
import {
  applicationDraftSchema,
  applicationDraftWriteSchema,
  type ApplicationDraft,
} from "../../data/application-draft";
import { createDatabase } from ".";
import { applicationDraft } from "./schema";
import { permissionValues, writePermission, type Actor } from "./access";
import { hasApplied } from "./profiles";
import { RequestError } from "../http";

export async function loadApplicationDraft(
  binding: Env["DB"],
  userId: string,
): Promise<ApplicationDraft | null> {
  const row = await createDatabase(binding).query.applicationDraft.findFirst({
    where: eq(applicationDraft.user_id, userId),
  });
  return row
    ? applicationDraftSchema.parse({
        version: row.version,
        revision: row.revision,
        answers: row.answers,
        updatedAt: row.updated_at.getTime(),
      })
    : null;
}

export async function saveApplicationDraft(
  binding: Env["DB"],
  actor: Actor,
  input: unknown,
): Promise<ApplicationDraft> {
  const parsed = applicationDraftWriteSchema.safeParse(input);
  if (!parsed.success)
    throw new RequestError(400, "Check the application draft answers.");
  const { userId, revision: previous, answers } = parsed.data;
  // An old tab must not save its answers to a newly signed-in account.
  if (userId !== actor.id)
    throw new RequestError(
      403,
      "Your account changed. Reload before continuing.",
    );
  const revision = crypto.randomUUID();
  const updatedAt = Date.now();
  const saved = await binding
    .prepare(
      `INSERT INTO application_draft (user_id, version, revision, answers, updated_at)
       SELECT ?, 1, ?, ?, ?
       WHERE NOT EXISTS (SELECT 1 FROM profile WHERE user_id=?)
       AND ${writePermission()}
       AND (? IS NULL OR EXISTS (SELECT 1 FROM application_draft WHERE user_id=? AND revision=?))
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
      previous,
    )
    .first();
  if (!saved) {
    const permitted = await binding
      .prepare(`SELECT 1 WHERE ${writePermission()}`)
      .bind(...permissionValues(actor))
      .first();
    if (!permitted) throw new RequestError(401, "Sign in to save your draft.");
    if (await hasApplied(binding, actor.id))
      throw new RequestError(
        410,
        "Your application has already been submitted.",
      );
    throw new RequestError(
      409,
      "Your draft changed on another tab or device. Choose which answers to keep.",
    );
  }
  return { version: 1, revision, answers, updatedAt };
}
