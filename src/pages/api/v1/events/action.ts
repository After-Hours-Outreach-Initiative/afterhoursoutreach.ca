import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { z } from "zod";
import { accountContext, requireOrganizer } from "@/server/db/access";
import { forwardCookies } from "@/server/auth";
import { takeRateLimit } from "@/server/db/rate-limits";
import { readJson, RequestError, errorResponse } from "@/server/http";
import {
  saveEvent,
  cancelEvent,
  changeSignup,
  manageSignup,
  eventSchema,
} from "@/server/db/events";
import { actionEmailResult } from "@/server/events/notifications";

const id = z.string().min(1).max(200);
const reason = z.string().trim().max(1000).default("");
const inputSchema = z.discriminatedUnion("action", [
  z.strictObject({
    action: z.literal("save"),
    id: id.optional(),
    version: z.number().int().nonnegative().optional(),
    event: eventSchema,
    notify: z.boolean().default(false),
  }),
  z.strictObject({
    action: z.literal("cancel-event"),
    id,
    version: z.number().int().nonnegative(),
    reason,
    notify: z.boolean().default(false),
  }),
  z.strictObject({ action: z.enum(["join", "cancel"]), id }),
  z.strictObject({
    action: z.literal("manage-signup"),
    id,
    destination: id.optional(),
    reason,
    notify: z.boolean().default(false),
  }),
  z.strictObject({
    action: z.literal("retry-notifications"),
    operation: z.uuid(),
  }),
]);
export const prerender = false;
export const POST: APIRoute = async ({ request }) => {
  try {
    const { actor, headers, bindings } = await accountContext(
      env,
      request,
      true,
    );
    if (!actor) throw new RequestError(401, "Sign in to continue.");
    const parsed = inputSchema.safeParse(await readJson(request));
    if (!parsed.success)
      throw new RequestError(400, "Check the event action and form fields.");
    const input = parsed.data;
    await takeRateLimit(
      env.DB,
      env.BETTER_AUTH_SECRET,
      `events:${actor.id}`,
      30,
      60_000,
    );
    let result: { operation?: string; message: string };
    switch (input.action) {
      case "save":
        result = await saveEvent(
          env.DB,
          actor,
          input.event,
          input.id,
          input.version,
          input.notify,
        );
        break;
      case "cancel-event":
        result = await cancelEvent(
          env.DB,
          actor,
          input.id,
          input.version,
          input.reason,
          input.notify,
        );
        break;
      case "join":
      case "cancel":
        result = await changeSignup(env.DB, actor, input.id, input.action);
        break;
      case "manage-signup":
        result = await manageSignup(
          env.DB,
          actor,
          input.id,
          input.destination,
          input.reason,
          input.notify,
        );
        break;
      case "retry-notifications":
        requireOrganizer(actor);
        if (
          !(await env.DB.prepare("SELECT id FROM event_audit WHERE id=?")
            .bind(input.operation)
            .first())
        )
          throw new RequestError(404, "Email action not found.");
        result = {
          operation: input.operation,
          message:
            "Email retry complete. The event/registration change was not repeated.",
        };
        break;
    }
    // Never send (or create retryable mail) without explicit organizer consent.
    const delivery = await actionEmailResult(
      bindings,
      result,
      input.action === "retry-notifications" ||
        ("notify" in input && input.notify),
    );
    const response = Response.json(
      {
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
