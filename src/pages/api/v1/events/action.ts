import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { accountContext } from "@/server/db/access";
import { forwardCookies } from "@/server/auth";
import { takeRateLimit } from "@/server/db/rate-limits";
import { readJson, RequestError, errorResponse } from "@/server/http";
import {
  eventActionNotifies,
  eventActionSchema,
  runEventAction,
} from "@/server/events/actions";
import { actionEmailResult } from "@/server/events/notifications";
import { orientationCapacityMessage } from "@/server/db/policy";
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
    if (!actor) throw new RequestError(401, "Sign in to continue.");
    // A staged list can contain up to 100 full-length manual names.
    const parsed = eventActionSchema.safeParse(await readJson(request, 65_536));
    if (!parsed.success)
      throw new RequestError(
        400,
        parsed.error.issues.find(
          (issue) => issue.message === orientationCapacityMessage,
        )?.message ??
          parsed.error.issues.find((issue) => issue.code === "custom")
            ?.message ??
          (parsed.error.issues.some((issue) => issue.path[0] === "volunteers")
            ? "Choose up to 100 volunteers with names of at most 200 characters and valid roles."
            : undefined) ??
          "Check the event action and form fields.",
      );
    const input = parsed.data;
    await takeRateLimit(
      env.DB,
      env.BETTER_AUTH_SECRET,
      `events:${actor.id}`,
      30,
      60_000,
    );
    // Nothing else may change an item while a change is waiting. Checked
    // first, so the organizer is offered that change instead of a stale
    // version error.
    await assertUnlocked(env.DB, "events", input);
    // Actions that email, cancel or delete wait so they can be undone.
    const pending = await schedulePendingAction(
      bindings,
      actor,
      "events",
      input,
    );
    const result = pending
      ? { message: pending.message }
      : await runEventAction(env.DB, actor, input);
    const delivery = pending
      ? { message: pending.message, pendingAction: pending.action }
      : await actionEmailResult(bindings, result, eventActionNotifies(input));
    const response = Response.json(
      {
        ...("id" in result && result.id ? { id: result.id } : {}),
        ...delivery,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
    forwardCookies(headers, response.headers);
    return response;
  } catch (error) {
    return errorResponse(error);
  }
};
