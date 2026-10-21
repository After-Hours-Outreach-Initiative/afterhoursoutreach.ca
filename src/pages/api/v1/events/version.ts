import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import {
  accountContext,
  canViewEvents,
  requireOrganizer,
} from "@/server/db/access";
import { forwardCookies } from "@/server/auth";
import {
  listEvents,
  listRosters,
  listPublicRosters,
  listPatrolSeries,
} from "@/server/db/events";
import { eventViewVersion } from "@/server/events/version";
import { errorResponse } from "@/server/http";

export const prerender = false;
export const GET: APIRoute = async ({ request }) => {
  try {
    const { actor, headers } = await accountContext(env, request);
    const params = new URL(request.url).searchParams;
    const manage = params.get("view") === "manage";
    if (manage) requireOrganizer(actor);
    const events = await listEvents(
      env.DB,
      actor,
      params.get("occurrence") ?? undefined,
      manage ? "manage" : "volunteer",
    );
    const series = manage && actor ? await listPatrolSeries(env.DB, actor) : [];
    const rosters =
      manage && actor
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
      !manage && canViewEvents(actor) && actor
        ? await listPublicRosters(
            env.DB,
            actor,
            events.map((event) => event.id),
          )
        : undefined,
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
