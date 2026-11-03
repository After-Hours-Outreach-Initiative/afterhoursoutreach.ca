import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { z } from "zod";
import { forwardCookies } from "@/server/auth";
import { accountContext, requireOrganizer } from "@/server/db/access";
import { searchSignupCandidates } from "@/server/db/events";
import { takeRateLimit } from "@/server/db/rate-limits";
import { errorResponse, RequestError } from "@/server/http";

const querySchema = z.strictObject({
  id: z.string().min(1).max(200),
  q: z.string().trim().max(100),
  exclude: z.array(z.string().min(1).max(200)).max(100),
});

export const prerender = false;
export const GET: APIRoute = async ({ request, url }) => {
  try {
    const { actor, headers } = await accountContext(env, request);
    requireOrganizer(actor);
    const parsed = querySchema.safeParse({
      id: url.searchParams.get("id"),
      q: url.searchParams.get("q") ?? "",
      exclude: url.searchParams.getAll("exclude"),
    });
    if (!parsed.success)
      throw new RequestError(400, "Check the event and search text.");
    await takeRateLimit(
      env.DB,
      env.BETTER_AUTH_SECRET,
      `event-volunteer-search:${actor.id}`,
      180,
      60_000,
    );
    const { id, q, exclude } = parsed.data;
    const volunteers = await searchSignupCandidates(
      env.DB,
      actor,
      id,
      q,
      exclude,
    );
    const response = Response.json(
      { volunteers },
      { headers: { "Cache-Control": "no-store" } },
    );
    forwardCookies(headers, response.headers);
    return response;
  } catch (error) {
    return errorResponse(error);
  }
};
