import { and, eq, or } from "drizzle-orm";
import { createDatabase } from "../../server/db";
import {
  account,
  auditLog,
  eventNotification,
  orientationCompletion,
  signup,
  user,
} from "../../server/db/schema";
import { RequestError } from "../../server/http";
import { isManualAccountPreset } from "../accounts";

// Creation metadata only; this provider cannot be used to sign in.
const disposableAccountProvider = "local-development-application";

export async function createDisposableAccount(binding: Env["DB"]) {
  const db = createDatabase(binding);
  const id = `local-application-${crypto.randomUUID()}`;
  const now = new Date();
  await db.batch([
    db.insert(user).values({
      id,
      name: "New application",
      email: `${id}@example.invalid`,
      email_verified: true,
      created_at: now,
      updated_at: now,
    }),
    db.insert(account).values({
      id: crypto.randomUUID(),
      user_id: id,
      account_id: id,
      provider_id: disposableAccountProvider,
      created_at: now,
      updated_at: now,
    }),
  ]);
  return id;
}

export async function deleteLocalAccount(binding: Env["DB"], userId: string) {
  // Immutable IDs can be checked before the batch: no demotion or child cleanup.
  if (isManualAccountPreset(userId))
    throw new RequestError(403, "Manual preset accounts cannot be deleted.");
  const db = createDatabase(binding);
  // Demote in the same transaction so the existing last-organizer trigger applies.
  // Cascades remove auth sessions, drafts, profile, status, and linked accounts.
  // Keep organizer-owned records: their FKs roll back the entire batch if referenced.
  const [, , , , , deleted] = await db.batch([
    db
      .update(user)
      .set({ role: "volunteer" })
      .where(and(eq(user.id, userId), eq(user.role, "organizer"))),
    db.delete(eventNotification).where(eq(eventNotification.user_id, userId)),
    db
      .delete(orientationCompletion)
      .where(eq(orientationCompletion.user_id, userId)),
    db.delete(signup).where(eq(signup.user_id, userId)),
    db
      .delete(auditLog)
      .where(
        or(eq(auditLog.subject_id, userId), eq(auditLog.actor_id, userId)),
      ),
    db.delete(user).where(eq(user.id, userId)).returning({ id: user.id }),
  ]);
  return deleted.length === 1;
}
