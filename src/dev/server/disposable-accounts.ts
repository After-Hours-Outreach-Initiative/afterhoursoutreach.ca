import { and, eq, exists, inArray, or } from "drizzle-orm";
import { createDatabase } from "../../server/db";
import {
  account,
  auditLog,
  eventNotification,
  orientationCompletion,
  signup,
  user,
} from "../../server/db/schema";

// Server-owned provenance, independent of the editable name/email. No schema or
// production account behavior changes: this provider cannot be used to sign in.
export const disposableAccountProvider = "local-development-application";
export const disposableAccountId = /^local-application-[0-9a-f-]{36}$/;

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

export async function deleteDisposableAccount(
  binding: Env["DB"],
  userId: string,
) {
  if (!disposableAccountId.test(userId)) return false;
  const db = createDatabase(binding);
  const eligible = db
    .select({ id: user.id })
    .from(user)
    .where(
      and(
        eq(user.id, userId),
        eq(user.role, "volunteer"),
        exists(
          db
            .select({ id: account.id })
            .from(account)
            .where(
              and(
                eq(account.user_id, user.id),
                eq(account.account_id, user.id),
                eq(account.provider_id, disposableAccountProvider),
              ),
            ),
        ),
      ),
    );
  // Recheck eligibility inside the transaction for every write. Cascades remove
  // auth sessions, drafts, profile, status, and the provenance marker last.
  // Do not delete organizer-owned events/records: their FKs roll back this batch.
  const [, , , , deleted] = await db.batch([
    db
      .delete(eventNotification)
      .where(inArray(eventNotification.user_id, eligible)),
    db
      .delete(orientationCompletion)
      .where(inArray(orientationCompletion.user_id, eligible)),
    db.delete(signup).where(inArray(signup.user_id, eligible)),
    db
      .delete(auditLog)
      .where(
        or(
          inArray(auditLog.subject_id, eligible),
          inArray(auditLog.actor_id, eligible),
        ),
      ),
    db
      .delete(user)
      .where(inArray(user.id, eligible))
      .returning({ id: user.id }),
  ]);
  return deleted.length === 1;
}
