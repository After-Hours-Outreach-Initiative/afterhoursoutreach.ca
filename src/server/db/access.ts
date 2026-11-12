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
import { personDisplayName } from "../../data/person-name";
import { contactEmail } from "../../data/site";
import { RequestError, requireSameOrigin } from "../http";
import { isApplicationComplete } from "./application-progress";
export { canViewEvents } from "./policy";

export async function accountContext(
  bindings: AuthBindings,
  request: Request,
  write = false,
) {
  const scoped = authBindingsForRequest(bindings, request);
  if (write) requireSameOrigin(request, new URL(scoped.AUTH_BASE_URL).origin);
  const auth = createAuth(scoped);
  const { response: current, headers } = await readAccountSession(
    auth,
    request,
  );
  if (!current?.user.emailVerified)
    return {
      actor: null,
      email: "",
      greetingName: "Account",
      headers,
      bindings: scoped,
      auth,
      current,
    };
  const { actor, greetingName } = await actorFor(
    bindings,
    current.user,
    current.session,
  );
  return {
    actor,
    email: current.user.email,
    greetingName,
    headers,
    bindings: scoped,
    auth,
    current,
  };
}

interface ActorPerson {
  id: string;
  name: string;
  role: "volunteer" | "organizer";
  twoFactorEnabled?: boolean | null;
}
interface ActorSession {
  id: string;
  twoFactorVerified: boolean;
}

async function actorFor(
  bindings: Pick<AuthBindings, "DB">,
  person: ActorPerson,
  session: ActorSession,
) {
  const db = createDatabase(bindings.DB);
  // Better Auth reads this user from D1: cookie caching and secondary storage
  // are disabled. Authorization is still rechecked inside each atomic write.
  const [status, application] = await Promise.all([
    db.query.volunteerStatus.findFirst({
      where: eq(volunteerStatus.user_id, person.id),
    }),
    db.query.profile.findFirst({
      where: eq(profile.user_id, person.id),
      columns: {
        first_name: true,
        last_name: true,
        preferred_name: true,
        registered_at: true,
        naloxone_completed_at: true,
      },
    }),
  ]);
  const names = {
    firstName: application?.first_name,
    lastName: application?.last_name,
    preferredName: application?.preferred_name,
  };
  const actor = {
    id: person.id,
    name: personDisplayName(names, person.name),
    sessionId: session.id,
    role: person.role,
    twoFactorEnabled: person.twoFactorEnabled,
    twoFactorVerified: session.twoFactorVerified,
    applicationSubmitted: Boolean(application),
    applicationComplete: isApplicationComplete({
      submittedAt: application?.registered_at?.getTime() ?? null,
      naloxoneCompletedAt:
        application?.naloxone_completed_at?.getTime() ?? null,
      applicationApproved: status?.registration_approved ?? false,
    }),
    naloxoneCompleted: Boolean(application?.naloxone_completed_at),
    active: status?.active ?? false,
    applicationApproved: status?.registration_approved ?? false,
    ...(status?.application_rejection_reason
      ? { applicationRejected: true as const }
      : {}),
    patrolApproved: status?.patrol_approved ?? false,
  };
  return { actor, greetingName: accountGreeting(names, person.name) };
}

/** Act for an account without a request, using one of its live sessions.
 * Every write still rechecks that session and the account's permissions. */
export async function storedActor(
  bindings: Pick<AuthBindings, "DB">,
  userId: string,
  preferredSessionId: string,
) {
  const row = await bindings.DB.prepare(
    `SELECT u.id, u.name, u.role, u.two_factor_enabled AS twoFactorEnabled,
      s.id AS sessionId, s.two_factor_verified AS twoFactorVerified
    FROM user u JOIN session s ON s.user_id = u.id
    WHERE u.id = ? AND s.expires_at > ? AND u.email_verified = 1 AND u.deleted_at IS NULL
      AND (u.two_factor_enabled = 0 OR s.two_factor_verified = 1)
    ORDER BY s.id = ? DESC, s.expires_at DESC LIMIT 1`,
  )
    .bind(userId, Date.now(), preferredSessionId)
    .first<{
      id: string;
      name: string;
      role: "volunteer" | "organizer";
      twoFactorEnabled: number;
      sessionId: string;
      twoFactorVerified: number;
    }>();
  if (!row) return null;
  const { actor } = await actorFor(
    bindings,
    {
      id: row.id,
      name: row.name,
      role: row.role,
      twoFactorEnabled: Boolean(row.twoFactorEnabled),
    },
    { id: row.sessionId, twoFactorVerified: Boolean(row.twoFactorVerified) },
  );
  return actor;
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
export function requireOrganizer(actor: Actor | null): asserts actor is Actor {
  requireVolunteer(actor);
  if (actor.role !== "organizer")
    throw new RequestError(403, "Organizer access is required.");
}
