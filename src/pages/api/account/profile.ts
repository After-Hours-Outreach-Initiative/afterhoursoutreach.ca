import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { accountsEnabled } from "@/data/environment";
import {
  authBindingsForRequest,
  createAuth,
  forwardCookies,
  readAccountSession,
} from "@/server/auth";
import { saveProfile } from "@/server/accounts/profile";
import { takeRateLimit } from "@/server/auth/abuse";
import {
  errorResponse,
  readJson,
  requireSameOrigin,
  RequestError,
} from "@/server/http";

export const prerender = false;
export const POST: APIRoute = async ({ request }) => {
  if (!accountsEnabled) return new Response("Not found", { status: 404 });
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
