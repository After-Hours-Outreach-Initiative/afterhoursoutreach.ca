import { RequestError } from "../http";

// Secrets are optional until Discord is configured; email sign-in is independent.
export type DiscordBindings = Pick<
  Env,
  | "DB"
  | "APP_ENV"
  | "DISCORD_CLIENT_ID"
  | "DISCORD_GUILD_ID"
  | "DISCORD_VOLUNTEER_ROLE_ID"
  | "DISCORD_ORGANIZER_ROLE_ID"
  | "DISCORD_MEDIC_ROLE_ID"
> & {
  DISCORD_CLIENT_SECRET?: string;
  DISCORD_BOT_TOKEN?: string;
  DISCORD_TOKEN_ENCRYPTION_KEY?: string;
};

export const snowflake = /^[0-9]{17,20}$/;
export const discordCallbackPath = "/api/v1/account/discord/callback";
export const discordCron = "* * * * *";

export function discordConfigured(env: DiscordBindings) {
  const roles = [
    env.DISCORD_VOLUNTEER_ROLE_ID,
    env.DISCORD_ORGANIZER_ROLE_ID,
    env.DISCORD_MEDIC_ROLE_ID,
  ];
  return (
    env.APP_ENV !== "preview" &&
    snowflake.test(env.DISCORD_CLIENT_ID) &&
    snowflake.test(env.DISCORD_GUILD_ID) &&
    roles.every((id) => snowflake.test(id) && id !== env.DISCORD_GUILD_ID) &&
    new Set(roles).size === 3 &&
    Boolean(
      env.DISCORD_CLIENT_SECRET &&
      env.DISCORD_BOT_TOKEN &&
      /^[A-Za-z0-9+/]{43}=$/.test(env.DISCORD_TOKEN_ENCRYPTION_KEY ?? ""),
    )
  );
}

export function requireDiscord(env: DiscordBindings) {
  if (!discordConfigured(env))
    throw new RequestError(
      503,
      "Discord connection is not configured. Please contact an organizer.",
    );
}

export function managedRoles(env: DiscordBindings) {
  return {
    volunteer: env.DISCORD_VOLUNTEER_ROLE_ID,
    organizer: env.DISCORD_ORGANIZER_ROLE_ID,
    medic: env.DISCORD_MEDIC_ROLE_ID,
  };
}
