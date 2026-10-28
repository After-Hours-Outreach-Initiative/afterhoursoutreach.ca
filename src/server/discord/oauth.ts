import { z } from "zod";
import { permissionValues, writePermission, type Actor } from "../db/access";
import { RequestError } from "../http";
import { challenge, digest, encryptToken, nonce } from "./crypto";
import {
  discordCallbackPath,
  requireDiscord,
  snowflake,
  type DiscordBindings,
} from "./config";

export const discordCookie = "aho_discord_link";
const startSchema = z.strictObject({
  userId: z.string(),
  consent: z.literal(true),
});

function requireAccount(actor: Actor | null): asserts actor is Actor {
  if (!actor || (actor.twoFactorEnabled && !actor.twoFactorVerified))
    throw new RequestError(401, "Sign in to connect Discord.");
}

export async function startDiscordLink(
  env: DiscordBindings,
  actor: Actor | null,
  origin: string,
  input: unknown,
) {
  requireDiscord(env);
  requireAccount(actor);
  const parsed = startSchema.safeParse(input);
  if (!parsed.success)
    throw new RequestError(400, "Agree to link Discord and join our server.");
  if (parsed.data.userId !== actor.id)
    throw new RequestError(
      403,
      "Your account changed. Reload before connecting Discord.",
    );
  const state = nonce(),
    browser = nonce(),
    verifier = nonce();
  const result = await env.DB.prepare(
    `INSERT INTO discord_oauth
    (state_hash,user_id,session_id,browser_hash,verifier,origin,expires_at)
    SELECT ?,?,?,?,?,?,? WHERE ${writePermission()} AND EXISTS
      (SELECT 1 FROM profile p WHERE user_id=? AND (naloxone_completed_at IS NOT NULL
        OR NOT EXISTS(SELECT 1 FROM discord_requirement WHERE user_id=p.user_id)))
    ON CONFLICT(user_id) DO UPDATE SET state_hash=excluded.state_hash,
      session_id=excluded.session_id,browser_hash=excluded.browser_hash,verifier=excluded.verifier,
      origin=excluded.origin,expires_at=excluded.expires_at`,
  )
    .bind(
      await digest(state),
      actor.id,
      actor.sessionId,
      await digest(browser),
      verifier,
      origin,
      Date.now() + 600_000,
      ...permissionValues(actor),
      actor.id,
    )
    .run();
  if (!result.meta.changes)
    throw new RequestError(
      409,
      "Submit your application and complete Naloxone 101 before connecting Discord.",
    );
  const url = new URL("https://discord.com/oauth2/authorize");
  url.search = new URLSearchParams({
    client_id: env.DISCORD_CLIENT_ID,
    response_type: "code",
    scope: "identify guilds.join",
    redirect_uri: origin + discordCallbackPath,
    state,
    prompt: "consent",
    code_challenge: await challenge(verifier),
    code_challenge_method: "S256",
  }).toString();
  return { url: url.href, browser };
}

export async function consumeDiscordState(
  env: DiscordBindings,
  actor: Actor | null,
  origin: string,
  state: string,
  browser: string,
) {
  requireDiscord(env);
  requireAccount(actor);
  if (
    !/^[A-Za-z0-9_-]{43}$/.test(state) ||
    !/^[A-Za-z0-9_-]{43}$/.test(browser)
  )
    throw new RequestError(
      403,
      "Discord authorization expired. Start again on this account.",
    );
  const row = await env.DB.prepare(
    `DELETE FROM discord_oauth WHERE state_hash=? AND browser_hash=?
    AND user_id=? AND session_id=? AND origin=? AND expires_at>?
    AND ${writePermission()} RETURNING verifier`,
  )
    .bind(
      await digest(state),
      await digest(browser),
      actor.id,
      actor.sessionId,
      origin,
      Date.now(),
      ...permissionValues(actor),
    )
    .first<{ verifier: string }>();
  if (!row)
    throw new RequestError(
      403,
      "Discord authorization expired or your account changed. Start again.",
    );
  return row.verifier;
}

const tokenSchema = z.object({
  access_token: z.string().min(1).max(4096),
  token_type: z.literal("Bearer"),
  expires_in: z.number().positive().max(31_536_000),
  scope: z.string(),
});
const identitySchema = z.object({
  id: z.string().regex(snowflake),
  username: z.string().min(1).max(100),
  bot: z.boolean().optional(),
});

/** No social-login provider, email matching, or account-merging endpoint exists. */
export async function finishDiscordLink(
  env: DiscordBindings,
  actor: Actor,
  origin: string,
  code: string,
  verifier: string,
  send: typeof fetch = fetch,
) {
  requireDiscord(env);
  const tokenResponse = await send("https://discord.com/api/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    signal: AbortSignal.timeout(8000),
    redirect: "error",
    body: new URLSearchParams({
      client_id: env.DISCORD_CLIENT_ID,
      client_secret: env.DISCORD_CLIENT_SECRET!,
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      redirect_uri: origin + discordCallbackPath,
    }),
  });
  if (!tokenResponse.ok)
    throw new RequestError(
      503,
      "Discord authorization could not be completed. Please reconnect later.",
    );
  const token = tokenSchema.parse(await tokenResponse.json());
  if (
    !["identify", "guilds.join"].every((scope) =>
      token.scope.split(" ").includes(scope),
    )
  )
    throw new RequestError(
      403,
      "Discord did not grant the required permissions. Please reconnect with consent.",
    );
  const identityResponse = await send("https://discord.com/api/v10/users/@me", {
    headers: { Authorization: `Bearer ${token.access_token}` },
    signal: AbortSignal.timeout(8000),
    redirect: "error",
  });
  if (!identityResponse.ok)
    throw new RequestError(
      503,
      "Discord identity could not be verified. Please reconnect later.",
    );
  const identity = identitySchema.parse(await identityResponse.json());
  if (identity.bot)
    throw new RequestError(
      400,
      "Connect your personal Discord account, not a bot.",
    );
  const encrypted = await encryptToken(
    env.DISCORD_TOKEN_ENCRYPTION_KEY!,
    token.access_token,
    `${actor.id}:${identity.id}:${env.DISCORD_GUILD_ID}`,
  );
  try {
    const result = await env.DB.prepare(
      `INSERT INTO discord_link
      (user_id,discord_id,username,guild_id,consented_at,join_token,token_expires_at,next_attempt_at)
      SELECT ?,?,?,?,?,?,?,? WHERE ${writePermission()}
        AND EXISTS(SELECT 1 FROM profile p WHERE user_id=? AND (naloxone_completed_at IS NOT NULL
          OR NOT EXISTS(SELECT 1 FROM discord_requirement WHERE user_id=p.user_id)))
      ON CONFLICT(user_id) DO UPDATE SET username=excluded.username,consented_at=excluded.consented_at,
        join_token=excluded.join_token,token_expires_at=excluded.token_expires_at,
        observed_roles=NULL,next_attempt_at=0,last_error=NULL,attempts=0,version=discord_link.version+1
      WHERE discord_link.discord_id=excluded.discord_id AND discord_link.guild_id=excluded.guild_id`,
    )
      .bind(
        actor.id,
        identity.id,
        identity.username,
        env.DISCORD_GUILD_ID,
        Date.now(),
        encrypted,
        Date.now() + token.expires_in * 1000,
        Date.now(),
        ...permissionValues(actor),
        actor.id,
      )
      .run();
    if (!result.meta.changes)
      throw new RequestError(
        409,
        "This account is already linked to a different Discord identity, or your session changed. Contact an organizer for help.",
      );
  } catch (error) {
    if (error instanceof RequestError) throw error;
    if (String(error).includes("UNIQUE constraint failed"))
      throw new RequestError(
        409,
        "That Discord identity is already linked to another volunteer account.",
      );
    throw error;
  }
  // Refresh tokens are intentionally never stored. Bot access handles role sync.
}
