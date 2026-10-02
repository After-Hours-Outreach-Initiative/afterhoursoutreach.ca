import { eq } from "drizzle-orm";
import {
  authBindingsForRequest,
  createAuth,
  readAccountSession,
} from "../auth";
import type { AuthBindings } from "../auth";
import { createDatabase } from "../db";
import { user, volunteerStatus, profile } from "../db/schema";
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
  // Roles and active status are read from D1, never cookies or submitted forms.
  const person = await db.query.user.findFirst({
    where: eq(user.id, current.user.id),
  });
  if (!person?.emailVerified)
    return { actor: null, email: "", headers, bindings: scoped };
  const status = await db.query.volunteerStatus.findFirst({
    where: eq(volunteerStatus.userId, person.id),
  });
  const registered = Boolean(
    await db.query.profile.findFirst({
      where: eq(profile.userId, person.id),
      columns: { userId: true },
    }),
  );
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
      patrolApproved: status?.patrolApproved ?? false,
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
    ${organizer ? "AND u.role='organizer' AND u.two_factor_enabled=1 AND s.two_factor_verified=1 AND v.active=1" : ""})`;
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
  if (!actor.twoFactorEnabled || !actor.twoFactorVerified)
    throw new RequestError(
      403,
      "Set up two-factor authentication in Your account, then sign in with your authenticator.",
    );
}
