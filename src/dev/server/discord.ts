import { z } from "zod";
import {
  permissionValues,
  writePermission,
  type Actor,
} from "../../server/db/access";
import type { DiscordBindings } from "../../server/discord/config";
import { loadDiscordStatus } from "../../server/discord/status";
import { eligibleRoles, type Eligibility } from "../../server/discord/sync";
import { RequestError } from "../../server/http";

const simulationSchema = z.strictObject({
  userId: z.string(),
  consent: z.literal(true),
  outcome: z.enum(["authorize", "screening", "unavailable"]),
});

/** Normal deletion flow, fictional links only; imported solely in DEV builds. */
export async function simulateDeletedDiscord(db: Env["DB"], userId: string) {
  await db
    .prepare(
      `DELETE FROM discord_link WHERE user_id=? AND guild_id='local-only'
    AND EXISTS (SELECT 1 FROM user WHERE id=discord_link.user_id AND deleted_at IS NOT NULL)`,
    )
    .bind(userId)
    .run();
}

/** Called only through DEV-gated imports; never receives or creates credentials. */
export async function simulateDiscordConnection(
  db: Env["DB"],
  actor: Actor,
  input: unknown,
) {
  if (actor.twoFactorEnabled && !actor.twoFactorVerified)
    throw new RequestError(401, "Sign in to connect Discord.");
  const parsed = simulationSchema.safeParse(input);
  if (!parsed.success)
    throw new RequestError(400, "Agree to link Discord and join our server.");
  if (parsed.data.userId !== actor.id)
    throw new RequestError(
      403,
      "Your account changed. Reload before connecting Discord.",
    );
  const eligible = `EXISTS (SELECT 1 FROM profile p WHERE p.user_id=?
    AND (p.naloxone_completed_at IS NOT NULL OR NOT EXISTS
      (SELECT 1 FROM discord_requirement WHERE user_id=p.user_id)))`;
  const allowed = await db
    .prepare(`SELECT 1 WHERE ${writePermission()} AND ${eligible}`)
    .bind(...permissionValues(actor), actor.id)
    .first();
  if (!allowed)
    throw new RequestError(
      409,
      "Submit your application and complete Naloxone 101 before connecting Discord.",
    );
  if (parsed.data.outcome === "unavailable")
    throw new RequestError(
      503,
      "Discord could not be connected. Please try again.",
    );

  const now = Date.now();
  const verified = parsed.data.outcome === "authorize" ? now : null;
  const result = await db
    .prepare(
      `INSERT INTO discord_link
      (user_id,discord_id,username,guild_id,consented_at,completed_at,
       member_verified_at,member_ready,checked_at,next_attempt_at,last_error)
      SELECT ?,?,'aho_volunteer','local-only',?,?,?,?,?,?,?
      WHERE ${writePermission()} AND ${eligible}
      ON CONFLICT(user_id) DO UPDATE SET
        consented_at=excluded.consented_at,
        completed_at=coalesce(discord_link.completed_at,excluded.completed_at),
        member_verified_at=excluded.member_verified_at,
        member_ready=excluded.member_ready,checked_at=excluded.checked_at,
        observed_roles=NULL,next_attempt_at=excluded.next_attempt_at,
        last_error=excluded.last_error,attempts=0,version=discord_link.version+1
      WHERE discord_link.discord_id=excluded.discord_id AND discord_link.guild_id='local-only'`,
    )
    .bind(
      actor.id,
      `local:${actor.id}`,
      now,
      verified,
      verified,
      verified === null ? 0 : 1,
      now,
      now,
      verified === null ? "membership_screening" : null,
      ...permissionValues(actor),
      actor.id,
    )
    .run();
  if (!result.meta.changes)
    throw new RequestError(
      409,
      "Your account changed or already has a different Discord connection. Reload before trying again.",
    );
}

/** Local stand-in for the bot's reconciliation job, scoped to fictional links. */
export async function loadLocalDiscordStatus(
  env: DiscordBindings,
  userId: string,
) {
  const link = await env.DB.prepare(
    `SELECT d.version,coalesce(v.active,0) AS active,
      CASE WHEN p.user_id IS NOT NULL THEN coalesce(v.registration_approved,0) ELSE 0 END AS approved,
      u.role='organizer' AS organizer,coalesce(v.patrol_approved,0) AS patrol,
      EXISTS(SELECT 1 FROM json_each(p.teams) WHERE value='medic') AS medic,
      EXISTS(SELECT 1 FROM orientation_completion o WHERE o.user_id=d.user_id) AS orientations
      FROM discord_link d JOIN user u ON u.id=d.user_id
      LEFT JOIN profile p ON p.user_id=d.user_id
      LEFT JOIN volunteer_status v ON v.user_id=d.user_id
      WHERE d.user_id=? AND d.discord_id=? AND d.guild_id='local-only'
        AND d.member_verified_at IS NOT NULL AND d.last_error IS NULL
        AND d.version!=d.synced_version`,
  )
    .bind(userId, `local:${userId}`)
    .first<Eligibility & { version: number }>();
  if (link) {
    const roles = eligibleRoles(link, {
      volunteer: "local-volunteer",
      organizer: "local-organizer",
      medic: "local-medic",
    });
    await env.DB.prepare(
      `UPDATE discord_link SET observed_roles=?,synced_version=version,last_synced_at=?
        WHERE user_id=? AND discord_id=? AND guild_id='local-only' AND version=?
          AND member_verified_at IS NOT NULL AND last_error IS NULL`,
    )
      .bind(
        JSON.stringify(roles),
        Date.now(),
        userId,
        `local:${userId}`,
        link.version,
      )
      .run();
  }
  return { ...(await loadDiscordStatus(env, userId)), configured: true };
}
