import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { forwardCookies } from "@/server/auth";
import { accountContext, requireVolunteer } from "@/server/db/access";
import { listEvents } from "@/server/db/events";
import { errorResponse } from "@/server/http";

export const prerender = false;
export const GET: APIRoute = async ({ request }) => {
  try {
    const { actor, headers } = await accountContext(env, request);
    requireVolunteer(actor);
    const events = (await listEvents(env.DB, actor))
      .filter(
        (event) =>
          event.startsAt > Date.now() && !event.cancelledAt && !event.hidden,
      )
      .map(({ id, type, startsAt, meetingPoint }) => ({
        id,
        type,
        startsAt,
        meetingPoint,
      }));
    const response = Response.json(
      { events },
      { headers: { "Cache-Control": "no-store" } },
    );
    forwardCookies(headers, response.headers);
    return response;
  } catch (error) {
    return errorResponse(error);
  }
};
