import { and, eq, ne } from "drizzle-orm";
import { createDatabase } from ".";
import { session } from "./schema";

export function markSessionSecondFactorVerified(
  binding: Env["DB"],
  token: string,
) {
  return createDatabase(binding)
    .update(session)
    .set({ two_factor_verified: true })
    .where(eq(session.token, token));
}

export function revokeOtherAccountSessions(
  binding: Env["DB"],
  userId: string,
  currentToken: string,
) {
  return createDatabase(binding)
    .delete(session)
    .where(and(eq(session.user_id, userId), ne(session.token, currentToken)));
}
