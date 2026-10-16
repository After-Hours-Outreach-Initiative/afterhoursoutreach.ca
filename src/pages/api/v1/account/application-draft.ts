import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { applicationDraftBodyLimit } from "@/data/application-draft";
import { forwardCookies } from "@/server/auth";
import { accountContext } from "@/server/db/access";
import {
  loadApplicationDraftState,
  discardApplicationDraft,
  saveApplicationDraft,
} from "@/server/db/application-drafts";
import { takeRateLimit } from "@/server/db/rate-limits";
import { errorResponse, readJson, RequestError } from "@/server/http";

export const prerender = false;

export const GET: APIRoute = async ({ request }) => {
  try {
    const { actor, headers } = await accountContext(env, request);
    if (!actor) throw new RequestError(401, "Sign in to resume your draft.");
    if (actor.twoFactorEnabled && !actor.twoFactorVerified)
      throw new RequestError(
        403,
        "Sign in with your authenticator to resume your draft.",
      );
    const response = Response.json(
      {
        userId: actor.id,
        submitted: actor.applicationSubmitted,
        ...(actor.applicationSubmitted
          ? { draft: null, generation: null }
          : await loadApplicationDraftState(env.DB, actor.id)),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
    forwardCookies(headers, response.headers);
    return response;
  } catch (error) {
    return errorResponse(error);
  }
};

export const PUT: APIRoute = async ({ request }) => {
  try {
    const { actor, headers } = await accountContext(env, request, true);
    if (!actor) throw new RequestError(401, "Sign in to save your draft.");
    await takeRateLimit(
      env.DB,
      env.BETTER_AUTH_SECRET,
      `application-draft-user:${actor.id}`,
      90,
      60_000,
    );
    const draft = await saveApplicationDraft(
      env.DB,
      actor,
      await readJson(request, applicationDraftBodyLimit),
    );
    const response = Response.json(
      { userId: actor.id, draft },
      { headers: { "Cache-Control": "no-store" } },
    );
    forwardCookies(headers, response.headers);
    return response;
  } catch (error) {
    return errorResponse(error);
  }
};

export const DELETE: APIRoute = async ({ request }) => {
  try {
    const { actor, headers } = await accountContext(env, request, true);
    if (!actor) throw new RequestError(401, "Sign in to discard your draft.");
    const result = await discardApplicationDraft(
      env.DB,
      actor,
      await readJson(request, 1024),
    );
    const response = Response.json(result, {
      headers: { "Cache-Control": "no-store" },
    });
    forwardCookies(headers, response.headers);
    return response;
  } catch (error) {
    return errorResponse(error);
  }
};
