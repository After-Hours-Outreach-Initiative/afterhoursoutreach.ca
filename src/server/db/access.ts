import { eq } from "drizzle-orm";
import {
  authBindingsForRequest,
  createAuth,
  readAccountSession,
} from "../auth";
import type { AuthBindings } from "../auth";
import { createDatabase } from ".";
import { profile, volunteerStatus } from "./schema";
import { accountGreeting } from "../../data/account-navigation";
import { contactEmail } from "../../data/site";
import { RequestError, requireSameOrigin } from "../http";
import {
  isApplicationComplete,
  loadApplicationProgress,
} from "./application-progress";

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
    return {
      actor: null,
      email: "",
      greetingName: "Account",
      headers,
      bindings: scoped,
    };
  const db = createDatabase(bindings.DB);
  // Better Auth reads this user from D1: cookie caching and secondary storage
  // are disabled. Authorization is still rechecked inside each atomic write.
  const person = current.user;
  const status = await db.query.volunteerStatus.findFirst({
    where: eq(volunteerStatus.user_id, person.id),
  });
  const application = await db.query.profile.findFirst({
    where: eq(profile.user_id, person.id),
    columns: {
      first_name: true,
      preferred_name: true,
      registered_at: true,
      naloxone_completed_at: true,
    },
  });
  return {
    actor: {
      id: person.id,
      name: person.name,
      sessionId: current.session.id,
      role: person.role,
      twoFactorEnabled: person.twoFactorEnabled,
      twoFactorVerified: current.session.twoFactorVerified,
      applicationSubmitted: Boolean(application),
      applicationComplete: isApplicationComplete(
        await loadApplicationProgress(bindings.DB, person.id),
      ),
      naloxoneCompleted: Boolean(application?.naloxone_completed_at),
      active: status?.active ?? false,
      applicationApproved: status?.registration_approved ?? false,
      ...(status?.application_rejection_reason
        ? { applicationRejected: true }
        : {}),
      patrolApproved: status?.patrol_approved ?? false,
    },
    email: person.email,
    greetingName: accountGreeting(
      {
        firstName: application?.first_name,
        preferredName: application?.preferred_name,
      },
      person.name,
    ),
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
  if (!actor.applicationSubmitted)
    throw new RequestError(403, "Complete your application first.");
  if (!actor.active)
    throw new RequestError(
      403,
      `Your volunteer account is inactive. Contact an organizer at ${contactEmail} to restore access.`,
    );
  if (!actor.applicationApproved && actor.role !== "organizer")
    throw new RequestError(
      403,
      "Your application is awaiting organizer approval.",
    );
  if (
    !actor.applicationComplete &&
    !actor.patrolApproved &&
    actor.role !== "organizer"
  )
    throw new RequestError(
      403,
      // Discord connection is temporarily disabled.
      // "Complete Naloxone 101 and the required Discord connection before viewing events.",
      "Complete Naloxone 101 before viewing events.",
    );
  if (actor.twoFactorEnabled && !actor.twoFactorVerified)
    throw new RequestError(403, "Sign in with your authenticator to continue.");
}
export function canViewEvents(actor: Actor | null): boolean {
  // Preserve existing patrol-approved volunteers and organizers, including legacy
  // accounts without a self-reported course date. New orientees need all milestones.
  return Boolean(
    actor?.applicationSubmitted &&
    actor.active &&
    (actor.applicationApproved || actor.role === "organizer") &&
    (actor.applicationComplete ||
      actor.patrolApproved ||
      actor.role === "organizer") &&
    (!actor.twoFactorEnabled || actor.twoFactorVerified),
  );
}
export function requireOrganizer(actor: Actor | null): asserts actor is Actor {
  requireVolunteer(actor);
  if (actor.role !== "organizer")
    throw new RequestError(403, "Organizer access is required.");
}
