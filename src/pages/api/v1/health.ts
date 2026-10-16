import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { assertDatabaseReady } from "../../../server/db/readiness";

export const prerender = false;

export const GET: APIRoute = async () => {
  try {
    await assertDatabaseReady(env.DB);
    return Response.json(
      { status: "ok" },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    // Do not expose database errors, configuration or personal information.
    return Response.json(
      { status: "unavailable" },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
};
