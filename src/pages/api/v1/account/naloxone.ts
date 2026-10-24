import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { forwardCookies } from "@/server/auth";
import { accountContext } from "@/server/db/access";
import { confirmNaloxoneCompletion } from "@/server/db/naloxone";
import { takeRateLimit } from "@/server/db/rate-limits";
import { errorResponse, readJson, RequestError } from "@/server/http";

export const prerender = false;
export const POST: APIRoute = async ({ request }) => {
  try {
    const { actor, headers } = await accountContext(env, request, true);
    if (!actor)
      throw new RequestError(401, "Sign in to confirm course completion.");
    if (actor.twoFactorEnabled && !actor.twoFactorVerified)
      throw new RequestError(
        403,
        "Sign in with your authenticator to confirm course completion.",
      );
    await takeRateLimit(
      env.DB,
      env.BETTER_AUTH_SECRET,
      `naloxone-user:${actor.id}`,
      20,
      60_000,
    );
    const result = await confirmNaloxoneCompletion(
      env.DB,
      actor,
      await readJson(request, 1024),
    );
    const response = Response.json(
      {
        ...result,
        message: "Completion saved to your account.",
      },
      { headers: { "Cache-Control": "no-store" } },
    );
    forwardCookies(headers, response.headers);
    return response;
  } catch (error) {
    return errorResponse(error);
  }
};
