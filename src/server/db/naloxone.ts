import { z } from "zod";
import { permissionValues, writePermission, type Actor } from "./access";
import { RequestError } from "../http";

export async function loadNaloxoneCompletion(db: Env["DB"], userId: string) {
  const row = await db
    .prepare(
      "SELECT naloxone_completed_at AS completedAt FROM profile WHERE user_id=?",
    )
    .bind(userId)
    .first<{ completedAt: number | null }>();
  return row?.completedAt ?? null;
}

const confirmationSchema = z.strictObject({
  userId: z.string().min(1).max(200),
  completed: z.literal(true),
});

export async function confirmNaloxoneCompletion(
  db: Env["DB"],
  actor: Actor,
  input: unknown,
) {
  const parsed = confirmationSchema.safeParse(input);
  if (!parsed.success)
    throw new RequestError(
      400,
      "Confirm that you have completed Naloxone 101.",
    );
  if (parsed.data.userId !== actor.id)
    throw new RequestError(
      403,
      "Your account changed. Reload before continuing.",
    );
  const now = Date.now();
  const results = await db.batch([
    db
      .prepare(
        `UPDATE profile SET naloxone_completed_at=?
       WHERE user_id=? AND naloxone_completed_at IS NULL AND ${writePermission()}`,
      )
      .bind(now, actor.id, ...permissionValues(actor)),
    db
      .prepare(
        `INSERT INTO audit_log (id,actor_id,subject_id,action,changed_fields,created_at)
       SELECT ?,?,?,'profile_updated','["naloxoneCompletedAt"]',? WHERE changes()=1`,
      )
      .bind(crypto.randomUUID(), actor.id, actor.id, now),
    db
      .prepare(
        `SELECT naloxone_completed_at AS completedAt FROM profile
       WHERE user_id=? AND ${writePermission()}`,
      )
      .bind(actor.id, ...permissionValues(actor)),
  ]);
  const row = results[2].results[0] as { completedAt: number } | undefined;
  if (!row) {
    const permitted = await db
      .prepare(`SELECT 1 WHERE ${writePermission()}`)
      .bind(...permissionValues(actor))
      .first();
    if (!permitted)
      throw new RequestError(
        401,
        "Sign in again to confirm course completion.",
      );
    throw new RequestError(
      409,
      "Submit your application form and Code of Conduct first.",
    );
  }
  // The null-to-timestamp comparison is the optimistic guard. Concurrent or
  // lost-response retries return the first confirmation without replacing it,
  // duplicating audits, or touching profile versions/the original form snapshot.
  return { completedAt: row.completedAt };
}
