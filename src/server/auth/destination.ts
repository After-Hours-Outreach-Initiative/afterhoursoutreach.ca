import { signInDestination } from "../../data/account-navigation";
import {
  isApplicationComplete,
  loadApplicationProgress,
} from "../db/application-progress";
import { canViewEvents } from "../db/policy";

/** Choose from current permissions, never a caller-supplied return URL. */
export async function signInDestinationForUser(
  db: Env["DB"],
  userId: string,
  twoFactorVerified = false,
) {
  const account = await db
    .prepare(
      `SELECT u.role, u.two_factor_enabled AS twoFactorEnabled,
        p.user_id IS NOT NULL AS applicationSubmitted,
        v.active, v.registration_approved AS applicationApproved,
        v.patrol_approved AS patrolApproved
      FROM user u LEFT JOIN profile p ON p.user_id=u.id
      LEFT JOIN volunteer_status v ON v.user_id=u.id WHERE u.id=?`,
    )
    .bind(userId)
    .first<{
      role: "volunteer" | "organizer";
      twoFactorEnabled: number;
      applicationSubmitted: number;
      active: number | null;
      applicationApproved: number | null;
      patrolApproved: number | null;
    }>();
  if (!account) return signInDestination;
  return canViewEvents({
    role: account.role,
    twoFactorEnabled: Boolean(account.twoFactorEnabled),
    twoFactorVerified,
    applicationSubmitted: Boolean(account.applicationSubmitted),
    applicationComplete: isApplicationComplete(
      await loadApplicationProgress(db, userId),
    ),
    active: Boolean(account.active),
    applicationApproved: Boolean(account.applicationApproved),
    patrolApproved: Boolean(account.patrolApproved),
  })
    ? "/events"
    : signInDestination;
}
