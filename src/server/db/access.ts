import { eq } from "drizzle-orm";
import {
  authBindingsForRequest,
  createAuth,
  readAccountSession,
} from "../auth";
import type { AuthBindings } from "../auth";
import { createDatabase } from ".";
import { volunteerStatus } from "./schema";
import { isRegistered } from "./profiles";
import { RequestError, requireSameOrigin } from "../http";

export async function accountContext(
  bindings: AuthBindings,
  request: Request,
  write = false,
) {
  const scoped = authBindingsForRequest(bindings, request);
  if (write) requireSameOrigin(request, new URL(scoped.AUTH_BASE_URL).origin);
  const { response: current, headers } = await readAccountSession(
    createAuth(scoped),
    request,
  );
  if (!current?.user.emailVerified)
    return { actor: null, email: "", headers, bindings: scoped };
  const db = createDatabase(bindings.DB);
  // Better Auth reads this user from D1: cookie caching and secondary storage
  // are disabled. Authorization is still rechecked inside each atomic write.
  const person = current.user;
  const status = await db.query.volunteerStatus.findFirst({
    where: eq(volunteerStatus.user_id, person.id),
  });
  const registered = await isRegistered(bindings.DB, person.id);
  return {
    actor: {
      id: person.id,
      name: person.name,
      sessionId: current.session.id,
      role: person.role,
      twoFactorEnabled: person.twoFactorEnabled,
      twoFactorVerified: current.session.twoFactorVerified,
      registered,
      active: status?.active ?? false,
      patrolApproved: status?.patrol_approved ?? false,
    },
    email: person.email,
    headers,
    bindings: scoped,
  };
}
export type Actor = NonNullable<
  Awaited<ReturnType<typeof accountContext>>["actor"]
>;

/** Recheck authorization inside each atomic write, including session revocation. */
export function writePermission(organizer = false) {
  return `EXISTS(SELECT 1 FROM user u JOIN session s ON s.user_id=u.id
    ${organizer ? "JOIN volunteer_status v ON v.user_id=u.id JOIN profile p ON p.user_id=u.id" : ""}
    WHERE u.id=? AND s.id=? AND s.expires_at>? AND u.email_verified=1
    AND (u.two_factor_enabled=0 OR s.two_factor_verified=1)
    ${organizer ? "AND u.role='organizer' AND v.active=1" : ""})`;
}
export const permissionValues = (actor: Actor) => [
  actor.id,
  actor.sessionId,
  Date.now(),
];

export function requireVolunteer(actor: Actor | null): asserts actor is Actor {
  if (!actor) throw new RequestError(401, "Sign in to continue.");
  if (!actor.registered)
    throw new RequestError(403, "Complete registration first.");
  if (!actor.active)
    throw new RequestError(403, "Your volunteer account is inactive.");
}
export function requireOrganizer(actor: Actor | null): asserts actor is Actor {
  requireVolunteer(actor);
  if (actor.role !== "organizer")
    throw new RequestError(403, "Organizer access is required.");
  if (actor.twoFactorEnabled && !actor.twoFactorVerified)
    throw new RequestError(403, "Sign in with your authenticator to continue.");
}
