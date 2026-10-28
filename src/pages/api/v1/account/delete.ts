import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import {
  authBindingsForRequest,
  createAuth,
  forwardCookies,
  readAccountSession,
} from "@/server/auth";
import {
  accountDeletionFreshAge,
  deleteOwnAccount,
} from "@/server/db/account-deletion";
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
    const { response: current } = await readAccountSession(auth, request);
    if (!current?.user.emailVerified)
      throw new RequestError(401, "Sign in to delete your account.");
    if (current.user.twoFactorEnabled && !current.session.twoFactorVerified)
      throw new RequestError(
        403,
        "Sign in with your authenticator before deleting your account.",
      );
    if (
      Date.now() - current.session.createdAt.getTime() >=
      accountDeletionFreshAge * 1000
    )
      throw new RequestError(
        403,
        "Sign in again before deleting your account. A sign-in within the last ten minutes is required.",
      );
    await deleteOwnAccount(
      env.DB,
      { userId: current.user.id, sessionId: current.session.id },
      await readJson(request),
    );
    if (import.meta.env.DEV) {
      const { simulateDeletedDiscord } = await import("@/dev/server/discord");
      await simulateDeletedDiscord(env.DB, current.user.id);
    }
    // All sessions are already revoked. Let Better Auth clear its own cookies;
    // never forward session-refresh cookies read before deletion.
    const signedOut = await auth.api.signOut({
      headers: request.headers,
      returnHeaders: true,
    });
    const response = Response.json(
      { next: "/volunteer/sign-in?deleted" },
      { headers: { "Cache-Control": "no-store" } },
    );
    forwardCookies(signedOut.headers, response.headers);
    return response;
  } catch (error) {
    return errorResponse(error);
  }
};
