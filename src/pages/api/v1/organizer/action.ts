import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { accountContext, requireOrganizer } from "@/server/db/access";
import { forwardCookies } from "@/server/auth";
import { takeRateLimit } from "@/server/db/rate-limits";
import { actionEmailResult } from "@/server/events/notifications";
import { readJson, RequestError, errorResponse } from "@/server/http";
import {
  organizerActionNotifies,
  organizerActionSchema,
  runOrganizerAction,
} from "@/server/organizer-actions";
import {
  assertUnlocked,
  schedulePendingAction,
} from "@/server/pending-actions";

export const prerender = false;
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
      `organizer:${actor.id}`,
      30,
      60_000,
    );
    const parsed = organizerActionSchema.safeParse(await readJson(request));
    if (!parsed.success)
      throw new RequestError(
        400,
        "Check the volunteer action and form fields.",
      );
    const input = parsed.data;
    // Nothing else may change the volunteer while a change is waiting. Checked
    // first, so the organizer is offered that change instead of a stale
    // version error.
    await assertUnlocked(env.DB, "organizer", input);
    // Actions that email wait so they can be undone.
    const pending = await schedulePendingAction(
      bindings,
      actor,
      "organizer",
      input,
    );
    const delivery = pending
      ? { message: pending.message, pendingAction: pending.action }
      : await runOrganizerAction(bindings, actor, input).then((result) =>
          actionEmailResult(
            bindings,
            result,
            organizerActionNotifies(input, result),
          ),
        );
    const response = Response.json(
      { ...delivery },
      { headers: { "Cache-Control": "no-store" } },
    );
    forwardCookies(headers, response.headers);
    return response;
  } catch (error) {
    return errorResponse(error);
  }
};
