import { z } from "zod";
import { RequestError } from "../http";
import { databaseWriteError } from "./errors";

export const accountDeletionFreshAge = 600;
const confirmationSchema = z.strictObject({
  userId: z.string().min(1).max(200),
  email: z.string().trim().toLowerCase().pipe(z.email().max(254)),
  confirm: z.literal(true),
});

export async function deleteOwnAccount(
  db: Env["DB"],
  current: { userId: string; sessionId: string },
  input: unknown,
) {
  const parsed = confirmationSchema.safeParse(input);
  if (!parsed.success)
    throw new RequestError(
      400,
      "Enter your email address and confirm account deletion.",
    );
  if (parsed.data.userId !== current.userId)
    throw new RequestError(
      409,
      "Your account changed. Reload before deleting it.",
    );
  const now = Date.now();
  try {
    // Recheck the live session, current email, second factor and sign-in age in
    // the write itself. Cleanup is a trigger in this same atomic statement.
    const result = await db
      .prepare(
        `UPDATE user SET deleted_at=?,updated_at=?,
      name='Deleted account',email=?,email_verified=0,image=NULL,
      two_factor_enabled=0,role='volunteer'
      WHERE id=? AND deleted_at IS NULL AND lower(email)=? AND email_verified=1
      AND EXISTS (SELECT 1 FROM session s WHERE s.user_id=user.id AND s.id=?
        AND s.expires_at>? AND s.created_at>? AND (user.two_factor_enabled=0 OR s.two_factor_verified=1))`,
      )
      .bind(
        now,
        now,
        `deleted-${crypto.randomUUID()}@account.invalid`,
        current.userId,
        parsed.data.email,
        current.sessionId,
        now,
        now - accountDeletionFreshAge * 1000,
      )
      .run();
    if (!result.meta.changes)
      throw new RequestError(
        409,
        "Your email or sign-in changed. Check your email and sign in again before deleting your account.",
      );
  } catch (error) {
    return databaseWriteError(error);
  }
}
