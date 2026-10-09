import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { z } from "zod";
import {
  authBindingsForRequest,
  createAuth,
  forwardCookies,
  readAccountSession,
} from "@/server/auth";
import { findOwnSession } from "@/server/db/sessions";
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
    const auth = createAuth(bindings);
    const { response: current, headers } = await readAccountSession(
      auth,
      request,
    );
    if (!current) throw new RequestError(401, "Sign in to manage sessions.");
    const parsed = z
      .object({ id: z.string().min(1).max(200) })
      .strict()
      .safeParse(await readJson(request));
    if (!parsed.success) throw new RequestError(400, "Choose a session.");
    if (parsed.data.id === current.session.id)
      return auth.api.signOut({ headers: request.headers, asResponse: true });
    // Keep bearer tokens out of the browser: resolve the submitted ID only
    // within this user's sessions, then let Better Auth perform revocation.
    const target = await findOwnSession(
      env.DB,
      current.user.id,
      parsed.data.id,
    );
    if (target) {
      const revoked = await auth.api.revokeSession({
        headers: request.headers,
        body: { token: target.token },
        returnHeaders: true,
      });
      forwardCookies(revoked.headers, headers);
    }
    const response = Response.json(
      { next: "/volunteer/account" },
      { headers: { "Cache-Control": "no-store" } },
    );
    forwardCookies(headers, response.headers);
    return response;
  } catch (error) {
    return errorResponse(error);
  }
};
