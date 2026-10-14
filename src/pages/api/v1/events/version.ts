import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { accountContext } from "@/server/db/access";
import { forwardCookies } from "@/server/auth";
import { listEvents } from "@/server/db/events";
import { eventViewVersion } from "@/server/events/version";
import { errorResponse } from "@/server/http";

export const prerender = false;
export const GET: APIRoute = async ({ request }) => {
  try {
    const { actor, headers } = await accountContext(env, request);
    const version = await eventViewVersion(
      await listEvents(env.DB, actor),
      actor,
    );
    const response = Response.json(
      { version },
      { headers: { "Cache-Control": "no-store" } },
    );
    forwardCookies(headers, response.headers);
    return response;
  } catch (error) {
    return errorResponse(error);
  }
};
