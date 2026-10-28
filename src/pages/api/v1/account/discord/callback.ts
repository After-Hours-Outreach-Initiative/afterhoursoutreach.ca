import type { APIRoute } from "astro";
import { env, waitUntil } from "cloudflare:workers";
import { forwardCookies } from "@/server/auth";
import { accountContext } from "@/server/db/access";
import { RequestError } from "@/server/http";
import {
  consumeDiscordState,
  discordCookie,
  finishDiscordLink,
} from "@/server/discord/oauth";
import { runDiscordJob } from "@/server/discord/sync";

export const prerender = false;
export const GET: APIRoute = async ({ request, url, cookies }) => {
  const destination = new URL("/volunteer/account", url.origin);
  try {
    const { actor, headers, bindings } = await accountContext(env, request);
    const origin = new URL(bindings.AUTH_BASE_URL).origin;
    const verifier = await consumeDiscordState(
      env,
      actor,
      origin,
      url.searchParams.get("state") ?? "",
      cookies.get(discordCookie)?.value ?? "",
    );
    if (url.searchParams.get("iss") !== "https://discord.com")
      throw new RequestError(
        403,
        "Discord authorization was not recognized. Start again.",
      );
    if (url.searchParams.has("error"))
      throw new RequestError(
        400,
        "Discord connection was cancelled. You can try again with consent.",
      );
    const code = url.searchParams.get("code");
    if (!code || code.length > 2048)
      throw new RequestError(
        400,
        "Discord authorization expired. Start again.",
      );
    await finishDiscordLink(env, actor!, origin, code, verifier);
    waitUntil(runDiscordJob(env));
    destination.searchParams.set("discord", "connected");
    const response = Response.redirect(destination, 303);
    // Redirect() headers are immutable, but session refresh cookies must survive.
    const result = new Response(null, {
      status: response.status,
      headers: response.headers,
    });
    forwardCookies(headers, result.headers);
    return result;
  } catch (error) {
    destination.searchParams.set(
      "discord",
      error instanceof RequestError
        ? error.message
        : "Discord could not be connected. Please try again.",
    );
    return new Response(null, {
      status: 303,
      headers: { Location: destination.href, "Cache-Control": "no-store" },
    });
  } finally {
    cookies.delete(discordCookie, { path: "/api/v1/account/discord/callback" });
  }
};
