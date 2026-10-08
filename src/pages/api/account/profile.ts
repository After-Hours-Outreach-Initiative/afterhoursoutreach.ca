import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import {
  authBindingsForRequest,
  createAuth,
  forwardCookies,
  readAccountSession,
} from "@/server/auth";
import { saveProfile } from "@/server/db/profiles";
import { takeRateLimit } from "@/server/db/rate-limits";
import {
  errorResponse,
  readJson,
  requireSameOrigin,
  RequestError,
} from "@/server/http";

export const prerender = false;
export const POST: APIRoute = async ({ request }) => {
  try {
    const bindings = authBindingsForRequest(env, request);
    requireSameOrigin(request, new URL(bindings.AUTH_BASE_URL).origin);
    const { response: current, headers } = await readAccountSession(
      createAuth(bindings),
      request,
    );
    if (!current?.user.emailVerified)
      throw new RequestError(401, "Sign in to edit your profile.");
    await takeRateLimit(
      env.DB,
      env.BETTER_AUTH_SECRET,
      `profile-user:${current.user.id}`,
      20,
      60_000,
    );
    await saveProfile(env.DB, current.user.id, await readJson(request));
    const response = Response.json(
      { next: "/volunteer/account", message: "Profile saved." },
      { headers: { "Cache-Control": "no-store" } },
    );
    forwardCookies(headers, response.headers);
    return response;
  } catch (error) {
    return errorResponse(error);
  }
};
