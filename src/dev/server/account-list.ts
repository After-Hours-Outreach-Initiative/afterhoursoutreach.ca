import type { DevelopmentAccountState } from "../accounts";
import {
  approvedMedicSql,
  includesOrientationSql,
  nowMsSql,
} from "../../server/db/sql";

interface AccountRow {
  id: string;
  name: string;
  email: string;
  role: "volunteer" | "organizer";
  submittedAt: number | null;
  naloxoneCompletedAt: number | null;
  discordRequired: number;
  discordCompletedAt: number | null;
  applicationApproved: number | null;
  active: number | null;
  patrolApproved: number | null;
  hasDraft: number;
  orientationCompleted: number;
  orientationBooked: number;
  medicSelected: number;
  medicEligible: number;
  twoFactorEnabled: number;
}

/** One paginated query, with the same eligibility rules as the event roster. */
export async function listLocalAccounts(db: Env["DB"], after?: string) {
  const { results } = await db
    .prepare(
      `SELECT u.id, u.name, u.email, u.role,
    p.registered_at AS submittedAt, p.naloxone_completed_at AS naloxoneCompletedAt,
    EXISTS(SELECT 1 FROM discord_requirement WHERE user_id=u.id) AS discordRequired,
    (SELECT completed_at FROM discord_link WHERE user_id=u.id) AS discordCompletedAt,
    v.registration_approved AS applicationApproved, v.active, v.patrol_approved AS patrolApproved,
    u.two_factor_enabled AS twoFactorEnabled,
    EXISTS (SELECT 1 FROM application_draft WHERE user_id=u.id) AS hasDraft,
    EXISTS (SELECT 1 FROM orientation_completion WHERE user_id=u.id) AS orientationCompleted,
    EXISTS (SELECT 1 FROM signup s JOIN event e ON e.id=s.event_id
      WHERE s.user_id=u.id AND s.status='confirmed' AND e.cancelled_at IS NULL
      AND e.starts_at>${nowMsSql} AND ${includesOrientationSql()}) AS orientationBooked,
    EXISTS (SELECT 1 FROM json_each(coalesce(p.teams, '[]')) WHERE value='medic') AS medicSelected,
    ${approvedMedicSql("u.id")} AS medicEligible
    FROM user u LEFT JOIN profile p ON p.user_id=u.id LEFT JOIN volunteer_status v ON v.user_id=u.id
    WHERE (? IS NULL OR u.id>?) ORDER BY u.id LIMIT 101`,
    )
    .bind(after ?? null, after ?? null)
    .all<AccountRow>();
  return {
    users: results.slice(0, 100).map(({ id, name, email, role, ...row }) => ({
      id,
      name,
      email,
      role,
      state: {
        submittedAt: row.submittedAt,
        naloxoneCompletedAt: row.naloxoneCompletedAt,
        discordRequired: Boolean(row.discordRequired),
        discordCompletedAt: row.discordCompletedAt,
        applicationApproved: Boolean(row.applicationApproved),
        active: Boolean(row.active),
        patrolApproved: Boolean(row.patrolApproved),
        hasDraft: Boolean(row.hasDraft),
        orientationCompleted: Boolean(row.orientationCompleted),
        orientationBooked: Boolean(row.orientationBooked),
        medicSelected: Boolean(row.medicSelected),
        medicEligible: Boolean(row.medicEligible),
        twoFactorEnabled: Boolean(row.twoFactorEnabled),
      } satisfies DevelopmentAccountState,
    })),
    next: results.length > 100 ? results[99].id : null,
  };
}
