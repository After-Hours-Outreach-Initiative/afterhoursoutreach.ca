import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { accountContext, canViewEvents } from "@/server/db/access";
import { forwardCookies } from "@/server/auth";
import { listEvents, listRosters, listPatrolSeries } from "@/server/db/events";
import { eventViewVersion } from "@/server/events/version";
import { errorResponse } from "@/server/http";

export const prerender = false;
export const GET: APIRoute = async ({ request }) => {
  try {
    const { actor, headers } = await accountContext(env, request);
    const events = await listEvents(
      env.DB,
      actor,
      new URL(request.url).searchParams.get("occurrence") ?? undefined,
    );
    const series =
      actor?.role === "organizer" && canViewEvents(actor)
        ? await listPatrolSeries(env.DB, actor)
        : [];
    const rosters =
      actor?.role === "organizer" && canViewEvents(actor)
        ? await listRosters(
            env.DB,
            actor,
            events.map((event) => event.id),
          )
        : [];
    const version = await eventViewVersion(
      events,
      actor,
      rosters,
      Date.now(),
      series,
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
