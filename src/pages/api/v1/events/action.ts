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
  deleteEvent,
  deletePatrolSeries,
  changeSignup,
  manageSignup,
  eventSchema,
  patrolSeriesSchema,
  patrolTemplateSchema,
  savePatrolSeries,
  updatePatrolSeriesFrom,
  stopPatrolSeries,
  materializePatrolOccurrence,
} from "@/server/db/events";
import { actionEmailResult } from "@/server/events/notifications";
import { orientationCapacityMessage } from "@/server/db/policy";

const id = z.string().min(1).max(200);
const reason = z.string().trim().max(1000).default("");
const inputSchema = z.discriminatedUnion("action", [
  z.strictObject({
    action: z.enum(["delete-event", "delete-series"]),
    id,
    version: z.number().int().nonnegative(),
    notify: z.boolean().default(false),
  }),
  z.strictObject({
    action: z.literal("save-series"),
    id: id.optional(),
    version: z.number().int().nonnegative().optional(),
    series: patrolSeriesSchema,
    notify: z.boolean().default(false),
  }),
  z.strictObject({
    action: z.literal("update-series-from"),
    id,
    occurrenceDate: z.iso.date(),
    version: z.number().int().nonnegative(),
    template: patrolTemplateSchema,
    notify: z.boolean().default(false),
  }),
  z.strictObject({
    action: z.literal("stop-series"),
    id,
    occurrenceDate: z.iso.date(),
    version: z.number().int().nonnegative(),
    reason,
    notify: z.boolean().default(false),
  }),
  z.strictObject({
    action: z.literal("materialize-occurrence"),
    id,
    occurrenceDate: z.iso.date(),
  }),
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
      throw new RequestError(
        400,
        parsed.error.issues.find(
          (issue) => issue.message === orientationCapacityMessage,
        )?.message ?? "Check the event action and form fields.",
      );
    const input = parsed.data;
    await takeRateLimit(
      env.DB,
      env.BETTER_AUTH_SECRET,
      `events:${actor.id}`,
      30,
      60_000,
    );
    let result: { operation?: string; message: string; id?: string };
    switch (input.action) {
      case "delete-event":
        result = await deleteEvent(
          env.DB,
          actor,
          input.id,
          input.version,
          input.notify,
        );
        break;
      case "delete-series":
        result = await deletePatrolSeries(
          env.DB,
          actor,
          input.id,
          input.version,
          input.notify,
        );
        break;
      case "save-series":
        result = await savePatrolSeries(
          env.DB,
          actor,
          input.series,
          input.id,
          input.version,
          input.notify,
        );
        break;
      case "update-series-from":
        result = await updatePatrolSeriesFrom(
          env.DB,
          actor,
          input.id,
          input.occurrenceDate,
          input.template,
          input.version,
          input.notify,
        );
        break;
      case "stop-series":
        result = await stopPatrolSeries(
          env.DB,
          actor,
          input.id,
          input.occurrenceDate,
          input.version,
          input.reason,
          input.notify,
        );
        break;
      case "materialize-occurrence":
        result = {
          ...(await materializePatrolOccurrence(
            env.DB,
            actor,
            input.id,
            input.occurrenceDate,
          )),
          message: "Occurrence ready to manage. Find it in the event list.",
        };
        break;
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
          !(await env.DB.prepare(
            "SELECT id FROM event_audit WHERE id=? UNION ALL SELECT id FROM patrol_series_audit WHERE id=? LIMIT 1",
          )
            .bind(input.operation, input.operation)
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
        ...(result.id ? { id: result.id } : {}),
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
