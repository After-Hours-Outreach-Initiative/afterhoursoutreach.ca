import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import {
  authBindingsForRequest,
  createAuth,
  readAccountSession,
} from "@/server/auth";
import { errorResponse, requireSameOrigin, RequestError } from "@/server/http";

export const prerender = false;
/** Sign this account out of every browser, including this one. */
export const POST: APIRoute = async ({ request }) => {
  try {
    const bindings = authBindingsForRequest(env, request);
    requireSameOrigin(request, new URL(bindings.AUTH_BASE_URL).origin);
    const auth = createAuth(bindings);
    const { response: current } = await readAccountSession(auth, request);
    if (!current?.user.emailVerified)
      throw new RequestError(401, "Sign in to manage sessions.");
    if (current.user.twoFactorEnabled && !current.session.twoFactorVerified)
      throw new RequestError(
        403,
        "Sign in with your authenticator to manage sessions.",
      );
    await auth.api.revokeSessions({ headers: request.headers });
    return auth.api.signOut({ headers: request.headers, asResponse: true });
  } catch (error) {
    return errorResponse(error);
  }
};
