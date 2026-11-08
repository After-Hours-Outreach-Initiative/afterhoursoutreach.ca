import { z } from "zod";
import {
  discordConfigured,
  managedRoles,
  type DiscordBindings,
} from "./config";
import { decryptToken } from "./crypto";

export interface Eligibility {
  active: number;
  approved: number;
  organizer: number;
  medic: number;
  patrol: number;
}
export function eligibleRoles(
  person: Eligibility,
  roles: ReturnType<typeof managedRoles>,
) {
  if (!person.active || !person.approved) return [];
  return [
    roles.volunteer,
    ...(person.organizer ? [roles.organizer] : []),
    ...(person.medic && person.patrol ? [roles.medic] : []),
  ];
}

interface Link extends Eligibility {
  deleted_at: number | null;
  user_id: string;
  discord_id: string;
  guild_id: string;
  version: number;
  observed_roles: string | null;
  member_ready: number;
  checked_at: number | null;
  join_token: string | null;
  token_expires_at: number | null;
  completed_at: number | null;
  attempts: number;
}
class Retry extends Error {
  constructor(
    public code: string,
    public at: number,
  ) {
    super(code);
  }
}
const memberSchema = z.object({
  user: z.object({ id: z.string() }),
  roles: z.array(z.string()),
  pending: z.boolean().optional(),
  joined_at: z.string().nullable(),
});

/** Serialized, bounded REST reconciliation with a durable cursor after each call.
 * All mutations use individual role endpoints, never replace roles or kick. */
export async function processDiscordSync(
  env: DiscordBindings,
  send: typeof fetch = fetch,
) {
  if (env.APP_ENV === "preview") return { processed: 0, disabled: true };
  // Expired credentials must be erased even if configuration is later disabled.
  await env.DB.batch([
    env.DB.prepare("DELETE FROM discord_oauth WHERE expires_at<?").bind(
      Date.now(),
    ),
    env.DB.prepare(
      "UPDATE discord_link SET join_token=NULL,token_expires_at=NULL WHERE token_expires_at<?",
    ).bind(Date.now()),
  ]);
  if (!discordConfigured(env)) return { processed: 0, disabled: true };
  const db = env.DB,
    lease = crypto.randomUUID();
  await db
    .prepare("INSERT OR IGNORE INTO discord_worker (id) VALUES (1)")
    .run();
  const claimed = await db
    .prepare(
      `UPDATE discord_worker SET lease_token=?,lease_until=?
    WHERE id=1 AND lease_until<? AND not_before<=?`,
    )
    .bind(lease, Date.now() + 60_000, Date.now(), Date.now())
    .run();
  if (!claimed.meta.changes) return { processed: 0 };
  let processed = 0;
  const started = Date.now();
  const checkpoint = (sql: string, ...values: (string | number | null)[]) =>
    db
      .prepare(
        `${sql}
    AND EXISTS(SELECT 1 FROM discord_worker WHERE id=1 AND lease_token=? AND lease_until>?)`,
      )
      .bind(...values, lease, Date.now())
      .run();
  // This is an extra conservative burst ceiling, not a hardcoded Discord quota.
  async function api(
    path: string,
    method = "GET",
    body?: object,
    beforeSend?: () => Promise<boolean>,
  ) {
    const window = Math.floor(Date.now() / 1000);
    const reserved = await db
      .prepare(
        `UPDATE discord_worker SET lease_until=?,request_window=?,
      request_count=CASE WHEN request_window=? THEN request_count+1 ELSE 1 END
      WHERE id=1 AND lease_token=? AND lease_until>? AND not_before<=?
      AND (request_window!=? OR request_count<20)`,
      )
      .bind(
        Date.now() + 60_000,
        window,
        window,
        lease,
        Date.now(),
        Date.now(),
        window,
      )
      .run();
    if (!reserved.meta.changes) {
      const row = await db
        .prepare(
          "SELECT not_before,lease_token,lease_until FROM discord_worker WHERE id=1",
        )
        .first<{
          not_before: number;
          lease_token: string | null;
          lease_until: number;
        }>();
      if (row?.lease_token !== lease || row.lease_until <= Date.now())
        throw new Retry("lease_lost", Date.now());
      throw new Retry(
        "rate_limited",
        Math.max(row?.not_before ?? 0, Date.now() + 1000),
      );
    }
    if (beforeSend && !(await beforeSend()))
      throw new Retry("state_changed", Date.now());
    const response = await send(`https://discord.com/api/v10${path}`, {
      method,
      headers: {
        Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`,
        "Content-Type": "application/json",
        "X-Audit-Log-Reason": "Website volunteer eligibility synchronization",
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(8000),
      redirect: "error",
    });
    let delay = 0;
    const seconds = (value: unknown, fallback: number) => {
      const parsed = Number(value);
      return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
    };
    if (response.headers.get("X-RateLimit-Remaining") === "0")
      delay = seconds(response.headers.get("X-RateLimit-Reset-After"), 1);
    if (response.status === 429) {
      const data = (await response.json().catch(() => ({}))) as {
        retry_after?: number;
      };
      delay = Math.max(
        delay,
        seconds(response.headers.get("Retry-After"), 0),
        seconds(data.retry_after, 1),
      );
    }
    if (delay > 0 && Number.isFinite(delay))
      await db
        .prepare(
          "UPDATE discord_worker SET not_before=max(not_before,?) WHERE id=1 AND lease_token=?",
        )
        .bind(Date.now() + Math.ceil(delay * 1000) + 250, lease)
        .run();
    if (response.status === 429)
      throw new Retry(
        "rate_limited",
        Date.now() + Math.ceil(delay * 1000) + 250,
      );
    if ([401, 403].includes(response.status)) {
      await db
        .prepare(
          "UPDATE discord_worker SET not_before=max(not_before,?) WHERE id=1 AND lease_token=?",
        )
        .bind(Date.now() + 3_600_000, lease)
        .run();
      throw new Retry("bot_permissions", Date.now() + 3_600_000);
    }
    if (!response.ok && response.status !== 404)
      throw new Retry("discord_unavailable", Date.now() + 60_000);
    return response;
  }
  try {
    for (let calls = 0; calls < 20 && Date.now() - started < 20_000; calls++) {
      const link = await db
        .prepare(
          `SELECT d.*,u.deleted_at,CASE WHEN u.deleted_at IS NULL THEN coalesce(v.active,0) ELSE 0 END AS active,
        CASE WHEN p.user_id IS NOT NULL THEN coalesce(v.registration_approved,0) ELSE 0 END AS approved,
        u.role='organizer' AS organizer,coalesce(v.patrol_approved,0) AS patrol,
        EXISTS(SELECT 1 FROM json_each(p.teams) WHERE value='medic') AS medic
        FROM discord_link d JOIN user u ON u.id=d.user_id
        LEFT JOIN profile p ON p.user_id=d.user_id LEFT JOIN volunteer_status v ON v.user_id=d.user_id
        WHERE d.guild_id=? AND d.next_attempt_at<=? ORDER BY d.next_attempt_at,d.user_id LIMIT 1`,
        )
        .bind(env.DISCORD_GUILD_ID, Date.now())
        .first<Link>();
      if (!link) break;
      const memberPath = `/guilds/${link.guild_id}/members/${link.discord_id}`;
      try {
        if (
          link.observed_roles === null ||
          (link.checked_at ?? 0) < Date.now() - 300_000
        ) {
          const response = await api(memberPath);
          if (response.status === 404) {
            if (link.deleted_at !== null) {
              await checkpoint(
                "DELETE FROM discord_link WHERE user_id=? AND version=?",
                link.user_id,
                link.version,
              );
              processed++;
              continue;
            }
            if (link.join_token && (link.token_expires_at ?? 0) > Date.now()) {
              // Joining is authorized only by the explicit, short-lived consent.
              const access_token = await decryptToken(
                env.DISCORD_TOKEN_ENCRYPTION_KEY!,
                link.join_token,
                `${link.user_id}:${link.discord_id}:${link.guild_id}`,
              );
              const joined = await api(
                memberPath,
                "PUT",
                { access_token },
                async () =>
                  Boolean(
                    (
                      await checkpoint(
                        `UPDATE discord_link SET observed_roles=NULL WHERE user_id=? AND version=? AND join_token=?
                  AND EXISTS (SELECT 1 FROM user WHERE id=discord_link.user_id AND deleted_at IS NULL)`,
                        link.user_id,
                        link.version,
                        link.join_token,
                      )
                    ).meta.changes,
                  ),
              );
              if (joined.status === 404)
                throw new Retry("membership_missing", Date.now() + 3_600_000);
              // Discard the credential after a successful join. A separate GET
              // must verify full membership (including Membership Screening).
              await checkpoint(
                "UPDATE discord_link SET join_token=NULL,token_expires_at=NULL WHERE user_id=? AND join_token=?",
                link.user_id,
                link.join_token,
              );
              continue;
            }
            await checkpoint(
              `UPDATE discord_link SET observed_roles=NULL,member_verified_at=NULL,member_ready=0,
              join_token=NULL,token_expires_at=NULL,last_error='membership_missing',next_attempt_at=? WHERE user_id=? AND version=?`,
              Date.now() + 3_600_000,
              link.user_id,
              link.version,
            );
            continue;
          }
          const member = memberSchema.parse(await response.json());
          if (member.user.id !== link.discord_id)
            throw new Retry("discord_unavailable", Date.now() + 60_000);
          const ready = !member.pending && member.joined_at !== null;
          await checkpoint(
            `UPDATE discord_link SET observed_roles=?,member_ready=?,checked_at=?,
            member_verified_at=CASE WHEN ? THEN ? ELSE NULL END,
            completed_at=CASE WHEN ? THEN coalesce(completed_at,?) ELSE completed_at END,
            join_token=NULL,token_expires_at=NULL WHERE user_id=? AND version=?`,
            JSON.stringify(member.roles),
            Number(ready),
            Date.now(),
            Number(ready),
            Date.now(),
            Number(ready),
            Date.now(),
            link.user_id,
            link.version,
          );
          continue;
        }
        const observed = JSON.parse(link.observed_roles) as string[];
        const roles = managedRoles(env);
        const wanted = link.member_ready ? eligibleRoles(link, roles) : [];
        // Remove first, especially when access/approval has been revoked.
        const remove = Object.values(roles).find(
          (id) => observed.includes(id) && !wanted.includes(id),
        );
        const add = wanted.find((id) => !observed.includes(id));
        const role = remove ?? add;
        if (role) {
          // Write-ahead uncertainty marker. A crash/timeout after Discord accepts
          // the mutation must force a fresh GET, not trust the pre-write cache.
          const response = await api(
            `${memberPath}/roles/${role}`,
            remove ? "DELETE" : "PUT",
            undefined,
            async () =>
              Boolean(
                (
                  await checkpoint(
                    "UPDATE discord_link SET observed_roles=NULL WHERE user_id=? AND version=?",
                    link.user_id,
                    link.version,
                  )
                ).meta.changes,
              ),
          );
          if (response.status === 404) {
            // Unknown member OR unknown role: re-read next time, never claim sync.
            throw new Retry(
              "membership_or_role_missing",
              Date.now() + 3_600_000,
            );
          }
          await checkpoint(
            "UPDATE discord_link SET observed_roles=? WHERE user_id=? AND version=?",
            JSON.stringify(
              remove
                ? observed.filter((id) => id !== role)
                : [...observed, role],
            ),
            link.user_id,
            link.version,
          );
          continue;
        }
        if (link.deleted_at !== null) {
          await checkpoint(
            "DELETE FROM discord_link WHERE user_id=? AND version=?",
            link.user_id,
            link.version,
          );
          processed++;
          continue;
        }
        await checkpoint(
          `UPDATE discord_link SET synced_version=?,last_synced_at=?,attempts=0,
          observed_roles=NULL,last_error=?,next_attempt_at=? WHERE user_id=? AND version=?`,
          link.version,
          Date.now(),
          link.member_ready ? null : "membership_screening",
          Date.now() + (link.member_ready ? 3_600_000 : 60_000),
          link.user_id,
          link.version,
        );
        processed++;
      } catch (error) {
        if (error instanceof Retry && error.code === "lease_lost") break;
        if (error instanceof Retry && error.code === "state_changed") continue;
        const retry =
          error instanceof Retry
            ? error
            : new Retry(
                "discord_unavailable",
                Date.now() +
                  Math.min(3_600_000, 30_000 * 2 ** Math.min(link.attempts, 7)),
              );
        await checkpoint(
          `UPDATE discord_link SET last_error=?,attempts=attempts+1,next_attempt_at=?
          WHERE user_id=? AND version=?`,
          retry.code,
          retry.at,
          link.user_id,
          link.version,
        );
        if (retry.code === "rate_limited" || retry.code === "bot_permissions")
          break;
      }
    }
  } finally {
    await db
      .prepare(
        "UPDATE discord_worker SET lease_token=NULL,lease_until=0 WHERE id=1 AND lease_token=?",
      )
      .bind(lease)
      .run();
  }
  return { processed };
}

export async function runDiscordJob(env: DiscordBindings) {
  try {
    console.log(
      JSON.stringify({
        event: "discord_sync",
        ...(await processDiscordSync(env)),
      }),
    );
  } catch {
    console.error(JSON.stringify({ event: "discord_sync_failed" }));
  }
}
