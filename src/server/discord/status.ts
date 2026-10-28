import {
  presentDiscordConnection,
  type DiscordConnectionStatus,
} from "@/data/discord-connection";
import type { DiscordBindings } from "./config";
import { discordConfigured } from "./config";

export async function loadDiscordStatus(
  env: DiscordBindings,
  userId: string,
): Promise<DiscordConnectionStatus> {
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
  return presentDiscordConnection({
    userId,
    configured: discordConfigured(env),
    link: row
      ? {
          username: row.username,
          discordId: row.discord_id,
          completedAt: row.completed_at,
          memberVerifiedAt: row.member_verified_at,
          lastSyncedAt: row.last_synced_at,
          lastError: row.last_error,
          version: row.version,
          syncedVersion: row.synced_version,
        }
      : null,
  });
}
