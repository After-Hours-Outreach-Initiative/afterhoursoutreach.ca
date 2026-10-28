import type { DiscordBindings } from "./config";
import { discordConfigured } from "./config";

export async function loadDiscordStatus(env: DiscordBindings, userId: string) {
  const row = await env.DB.prepare(
    `SELECT username,discord_id,completed_at,member_verified_at,
    version,synced_version,last_synced_at,last_error,next_attempt_at FROM discord_link WHERE user_id=?`,
  )
    .bind(userId)
    .first<{
      username: string;
      discord_id: string;
      completed_at: number | null;
      member_verified_at: number | null;
      version: number;
      synced_version: number;
      last_synced_at: number | null;
      last_error: string | null;
      next_attempt_at: number;
    }>();
  const configured = discordConfigured(env);
  const connection = !row
    ? "Not connected"
    : row.last_error === "membership_missing"
      ? "Not in the server. Reconnect Discord to join again."
      : row.last_error === "membership_screening"
        ? "Accept the server rules in Discord to complete membership screening."
        : row.member_verified_at !== null
          ? "Server membership verified"
          : "Joining and verifying server membership";
  const sync = !configured
    ? "Discord is not configured. Contact an organizer."
    : !row
      ? "Connect Discord to enable role synchronization."
      : row.last_error === "bot_permissions"
        ? "Role sync needs an organizer to check the bot’s permissions. It will retry automatically."
        : row.last_error === "rate_limited"
          ? "Discord requested a pause. Role sync will retry automatically."
          : row.last_error &&
              !["membership_missing", "membership_screening"].includes(
                row.last_error,
              )
            ? "Discord sync is delayed. We will retry automatically; contact an organizer if it persists."
            : row.version !== row.synced_version
              ? "Role sync pending"
              : "Roles synchronized with your current website eligibility";
  return {
    userId,
    configured,
    username: row?.username ?? null,
    discordId: row?.discord_id ?? null,
    completedAt: row?.completed_at ?? null,
    memberVerifiedAt: row?.member_verified_at ?? null,
    lastSyncedAt: row?.last_synced_at ?? null,
    connection,
    sync,
  };
}
