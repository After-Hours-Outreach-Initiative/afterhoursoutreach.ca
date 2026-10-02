import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { accountsEnabled } from "@/data/environment";
import {
  authBindingsForRequest,
  createAuth,
  forwardCookies,
  readAccountSession,
} from "@/server/auth";
import { createDatabase } from "@/server/db";
import { session } from "@/server/db/schema";
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
    await createDatabase(env.DB)
      .delete(session)
      .where(
        and(
          eq(session.id, parsed.data.id),
          eq(session.userId, current.user.id),
        ),
      );
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
