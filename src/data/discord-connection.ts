export interface DiscordConnectionStatus {
  userId: string;
  configured: boolean;
  username: string | null;
  discordId: string | null;
  needsReconnect: boolean;
  completedAt: number | null;
  memberVerifiedAt: number | null;
  lastSyncedAt: number | null;
  connection: string;
  sync: string;
}

export interface DiscordConnectionLink {
  username: string;
  discordId: string;
  completedAt: number | null;
  memberVerifiedAt: number | null;
  lastSyncedAt: number | null;
  lastError: string | null;
  version: number;
  syncedVersion: number;
}

/** Present stored connection state without database or environment dependencies. */
export function presentDiscordConnection({
  userId,
  configured,
  link,
}: {
  userId: string;
  configured: boolean;
  link: DiscordConnectionLink | null;
}): DiscordConnectionStatus {
  const connection = !link
    ? "Not connected"
    : link.lastError === "membership_missing"
      ? "Not in the server. Reconnect Discord to join again."
      : link.lastError === "membership_screening"
        ? "Accept the server rules in Discord to complete membership screening."
        : link.memberVerifiedAt !== null
          ? "Server membership verified"
          : "Joining and verifying server membership";
  const sync = !link
    ? "Connect Discord to enable role synchronization."
    : link.lastError === "bot_permissions"
      ? "Role sync is temporarily unavailable. It will retry automatically."
      : link.lastError === "rate_limited"
        ? "Discord requested a pause. Role sync will retry automatically."
        : link.lastError &&
            !["membership_missing", "membership_screening"].includes(
              link.lastError,
            )
          ? "Discord sync is delayed. We will retry automatically; contact an organizer if it persists."
          : link.version !== link.syncedVersion
            ? "Role sync pending"
            : "Roles synchronized with your current website eligibility";
  return {
    userId,
    configured,
    username: link?.username ?? null,
    discordId: link?.discordId ?? null,
    needsReconnect: link?.lastError === "membership_missing",
    completedAt: link?.completedAt ?? null,
    memberVerifiedAt: link?.memberVerifiedAt ?? null,
    lastSyncedAt: link?.lastSyncedAt ?? null,
    connection,
    sync,
  };
}

export function discordConnectionDescription(
  configured: boolean,
  required: boolean,
): string {
  return !configured
    ? "Discord connection is coming soon."
    : required
      ? "Connect Discord to access our volunteer channels once you’re approved."
      : "Connect Discord to keep your volunteer channel access up to date. This is optional.";
}

export function discordConnectionIdentity(
  status: DiscordConnectionStatus,
): string {
  return status.username
    ? `${status.memberVerifiedAt !== null ? "Connected" : "Linked"} as ${status.username}.`
    : "";
}

export function discordConnectionMessage(
  status: DiscordConnectionStatus,
): string {
  return status.username
    ? `${status.connection.replace(/\.$/, "")}. ${status.sync.replace(/\.$/, "")}.`
    : "";
}
