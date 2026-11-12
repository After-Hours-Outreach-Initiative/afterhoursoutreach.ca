import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { z } from "zod";
import { accountContext, requireOrganizer } from "@/server/db/access";
import { forwardCookies } from "@/server/auth";
import { takeRateLimit } from "@/server/db/rate-limits";
import { readJson, RequestError, errorResponse } from "@/server/http";
import {
  dismissPendingAction,
  listPendingActions,
  runDuePendingActions,
  runPendingAction,
  undoPendingAction,
} from "@/server/pending-actions";

const inputSchema = z.strictObject({
  action: z.enum(["undo", "run", "dismiss"]),
  id: z.uuid(),
});

export const prerender = false;
export const GET: APIRoute = async ({ request }) => {
  try {
    const { actor, headers, bindings } = await accountContext(env, request);
    // Also the fallback scheduler wherever the minute cron does not run, such
    // as local development. Due changes are made even when the page asking
    // has been signed out; they run as their author.
    await runDuePendingActions(bindings).catch(() => {});
    requireOrganizer(actor);
    const response = Response.json(
      { actions: await listPendingActions(env.DB, actor) },
      { headers: { "Cache-Control": "no-store" } },
    );
    forwardCookies(headers, response.headers);
    return response;
  } catch (error) {
    return errorResponse(error);
  }
};

export const POST: APIRoute = async ({ request }) => {
  try {
    const { actor, headers, bindings } = await accountContext(
      env,
      request,
      true,
    );
    requireOrganizer(actor);
    await takeRateLimit(
      env.DB,
      env.BETTER_AUTH_SECRET,
      `pending-actions:${actor.id}`,
      60,
      60_000,
    );
    const parsed = inputSchema.safeParse(await readJson(request));
    if (!parsed.success) throw new RequestError(400, "Choose a change.");
    const { action, id } = parsed.data;
    let body: object = {};
    if (action === "undo") {
      await undoPendingAction(env.DB, actor, id);
      body = { status: "undone", message: "Change undone." };
    } else if (action === "dismiss") {
      await dismissPendingAction(env.DB, actor, id);
    } else {
      const result = await runPendingAction(bindings, id, actor);
      if (!result)
        throw new RequestError(409, "This change was already made or undone.");
      body = {
        ...result.delivery,
        status: result.status,
        message: result.message,
      };
    }
    const response = Response.json(body, {
      headers: { "Cache-Control": "no-store" },
    });
    forwardCookies(headers, response.headers);
    return response;
  } catch (error) {
    return errorResponse(error);
  }
};
