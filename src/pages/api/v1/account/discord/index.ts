import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { forwardCookies } from "@/server/auth";
import { accountContext } from "@/server/db/access";
import { takeRateLimit } from "@/server/db/rate-limits";
import { errorResponse, readJson, RequestError } from "@/server/http";
import { discordCookie, startDiscordLink } from "@/server/discord/oauth";
import { loadDiscordStatus } from "@/server/discord/status";

export const prerender = false;
export const GET: APIRoute = async ({ request }) => {
  try {
    const { actor, headers } = await accountContext(env, request);
    if (!actor || (actor.twoFactorEnabled && !actor.twoFactorVerified))
      throw new RequestError(401, "Sign in to view your Discord connection.");
    const status = import.meta.env.DEV
      ? await (
          await import("@/dev/server/discord")
        ).loadLocalDiscordStatus(env, actor.id)
      : await loadDiscordStatus(env, actor.id);
    const response = Response.json(status, {
      headers: { "Cache-Control": "no-store" },
    });
    forwardCookies(headers, response.headers);
    return response;
  } catch (error) {
    return errorResponse(error);
  }
};
export const POST: APIRoute = async ({ request, cookies }) => {
  try {
    const { actor, headers, bindings } = await accountContext(
      env,
      request,
      true,
    );
    if (!actor || (actor.twoFactorEnabled && !actor.twoFactorVerified))
      throw new RequestError(401, "Sign in to connect Discord.");
    const input = await readJson(request, 1024);
    if (import.meta.env.DEV) {
      const { simulateDiscordConnection } =
        await import("@/dev/server/discord");
      await simulateDiscordConnection(env.DB, actor, input);
      const response = Response.json(
        { simulated: true },
        {
          headers: { "Cache-Control": "no-store" },
        },
      );
      forwardCookies(headers, response.headers);
      return response;
    }
    await takeRateLimit(
      env.DB,
      env.BETTER_AUTH_SECRET,
      `discord-connect:${actor.id}`,
      5,
      60_000,
    );
    const { url, browser } = await startDiscordLink(
      env,
      actor,
      new URL(bindings.AUTH_BASE_URL).origin,
      input,
    );
    cookies.set(discordCookie, browser, {
      httpOnly: true,
      secure: new URL(request.url).protocol === "https:",
      sameSite: "lax",
      path: "/api/v1/account/discord/callback",
      maxAge: 600,
    });
    const response = Response.json(
      { url },
      { headers: { "Cache-Control": "no-store" } },
    );
    forwardCookies(headers, response.headers);
    return response;
  } catch (error) {
    return errorResponse(error);
  }
};
