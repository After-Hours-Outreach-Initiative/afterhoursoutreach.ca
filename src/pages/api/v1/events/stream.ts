import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { accountContext } from "@/server/db/access";
import { forwardCookies } from "@/server/auth";
import { listEvents } from "@/server/db/events";
import { eventStream, eventViewVersion } from "@/server/events/stream";
import { errorResponse } from "@/server/http";

export const prerender = false;
export const GET: APIRoute = async ({ request }) => {
  try {
    const { actor, headers } = await accountContext(env, request);
    const version = await eventViewVersion(
      await listEvents(env.DB, actor),
      actor,
    );
    const response = new Response(
      eventStream(
        version,
        async () => {
          // Do not retain organizer access or a revoked session for the lifetime
          // of a connection. D1 polling also observes writes in other isolates.
          const { actor } = await accountContext(env, request);
          return eventViewVersion(await listEvents(env.DB, actor), actor);
        },
        request.signal,
      ),
      {
        headers: {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-store",
          "X-Accel-Buffering": "no",
        },
      },
    );
    forwardCookies(headers, response.headers);
    return response;
  } catch (error) {
    return errorResponse(error);
  }
};
