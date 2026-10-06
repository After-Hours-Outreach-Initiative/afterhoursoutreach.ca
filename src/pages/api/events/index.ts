import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { authBindingsForRequest } from "@/server/auth";
import { listEvents } from "@/server/events/service";
import { errorResponse } from "@/server/http";

export const prerender = false;
export const GET: APIRoute = async ({ request }) => {
  try {
    authBindingsForRequest(env, request);
    const events = (await listEvents(env.DB, null)).map(
      ({ id, type, startsAt, meetingPoint }) => ({
        id,
        type,
        startsAt,
        meetingPoint,
      }),
    );
    return Response.json(
      { events },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return errorResponse(error);
  }
};
