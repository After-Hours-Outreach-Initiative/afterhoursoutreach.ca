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
import { listViewerEvents, resolveEventViewer } from "@/server/events/view-as";
import { errorResponse } from "@/server/http";

export const prerender = false;
export const GET: APIRoute = async ({ request }) => {
  try {
    const { actor, headers } = await accountContext(env, request);
    const params = new URL(request.url).searchParams;
    // Match an organizer's preview, which lists events for another viewer.
    const viewer = await resolveEventViewer(
      env.DB,
      actor,
      params.get("viewAs"),
    );
    const manage = !viewer && params.get("view") === "manage";
    if (manage) requireOrganizer(actor);
    const subject = viewer?.actor ?? actor;
    const events = viewer
      ? await listViewerEvents(env.DB, viewer, "volunteer")
      : await listEvents(
          env.DB,
          actor,
          params.get("occurrence") ?? undefined,
          manage ? "manage-upcoming" : "volunteer",
        );
    const pastEvents = viewer
      ? await listViewerEvents(env.DB, viewer, "past")
      : await listEvents(
          env.DB,
          actor,
          manage ? (params.get("occurrence") ?? undefined) : undefined,
          manage ? "manage-past" : "past",
        );
    const series = manage && actor ? await listPatrolSeries(env.DB, actor) : [];
    const rosters =
      manage && actor
        ? await listRosters(
            env.DB,
            actor,
            [...events, ...(manage ? pastEvents : [])].map((event) => event.id),
          )
        : [];
    const version = await eventViewVersion(
      [...events, ...pastEvents],
      subject,
      rosters,
      Date.now(),
      series,
      !manage && canViewEvents(subject) && subject
        ? await listPublicRosters(
            env.DB,
            subject,
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
