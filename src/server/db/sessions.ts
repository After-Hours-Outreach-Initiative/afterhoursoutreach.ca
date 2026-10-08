import { and, eq } from "drizzle-orm";
import { createDatabase } from ".";
import { session } from "./schema";

/** Resolve IDs only within the caller's sessions; tokens never reach the browser. */
export function findOwnSession(binding: Env["DB"], userId: string, id: string) {
  return createDatabase(binding)
    .select({ token: session.token })
    .from(session)
    .where(and(eq(session.id, id), eq(session.user_id, userId)))
    .get();
}

export function markSessionSecondFactorVerified(
  binding: Env["DB"],
  token: string,
) {
  return createDatabase(binding)
    .update(session)
    .set({ two_factor_verified: true })
    .where(eq(session.token, token));
}
