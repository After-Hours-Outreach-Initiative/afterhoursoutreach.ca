import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { z } from "zod";
import { accountContext, requireOrganizer } from "@/server/db/access";
import {
  setVolunteerStatus,
  setRole,
  completeOrientation,
  statusSchema,
} from "@/server/db/volunteers";
import { forwardCookies } from "@/server/auth";
import { takeRateLimit } from "@/server/db/rate-limits";
import { actionEmailResult } from "@/server/events/notifications";
import { readJson, RequestError, errorResponse } from "@/server/http";

const id = z.string().min(1).max(200);
const inputSchema = z.discriminatedUnion("action", [
  statusSchema.extend({ action: z.literal("status") }),
  z.strictObject({
    action: z.literal("role"),
    userId: id,
    role: z.enum(["volunteer", "organizer"]),
    notify: z.boolean().default(false),
  }),
  z.strictObject({ action: z.literal("orientation"), userId: id, eventId: id }),
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
    requireOrganizer(actor);
    await takeRateLimit(
      env.DB,
      env.BETTER_AUTH_SECRET,
      `organizer:${actor.id}`,
      30,
      60_000,
    );
    const parsed = inputSchema.safeParse(await readJson(request));
    if (!parsed.success)
      throw new RequestError(
        400,
        "Check the volunteer action and form fields.",
      );
    const input = parsed.data;
    if (
      input.action === "retry-notifications" &&
      !(await env.DB.prepare(
        "SELECT id FROM audit_log WHERE id=? AND action IN ('approval_changed','active_changed','role_changed')",
      )
        .bind(input.operation)
        .first())
    )
      throw new RequestError(404, "Email action not found.");
    const result =
      input.action === "retry-notifications"
        ? {
            operation: input.operation,
            message:
              "Email retry complete. The account change was not repeated.",
          }
        : input.action === "status"
          ? await setVolunteerStatus(env.DB, actor, {
              userId: input.userId,
              version: input.version,
              active: input.active,
              applicationApproved: input.applicationApproved,
              registrationApproved: input.registrationApproved,
              patrolApproved: input.patrolApproved,
              notify: input.notify,
            })
          : input.action === "role"
            ? await setRole(
                env.DB,
                actor,
                input.userId,
                input.role,
                input.notify,
              )
            : await completeOrientation(
                env.DB,
                actor,
                input.userId,
                input.eventId,
              );
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
