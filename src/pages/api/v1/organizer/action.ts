import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { z } from "zod";
import { accountContext, requireOrganizer } from "@/server/db/access";
import {
  setVolunteerStatus,
  setRole,
  completeOrientation,
  approveForPatrols,
  patrolApprovalSchema,
  statusSchema,
  rejectionSchema,
  rejectApplication,
} from "@/server/db/volunteers";
import { forwardCookies } from "@/server/auth";
import { takeRateLimit } from "@/server/db/rate-limits";
import { actionEmailResult } from "@/server/events/notifications";
import { readJson, RequestError, errorResponse } from "@/server/http";

const id = z.string().min(1).max(200);
const inputSchema = z.discriminatedUnion("action", [
  statusSchema.extend({ action: z.literal("status") }),
  rejectionSchema.extend({ action: z.literal("reject-application") }),
  patrolApprovalSchema.extend({ action: z.literal("approve-patrols") }),
  z.strictObject({
    action: z.literal("role"),
    userId: id,
    role: z.enum(["volunteer", "organizer"]),
    notify: z.boolean().default(false),
  }),
  z.strictObject({
    action: z.literal("orientation"),
    userId: id,
    eventId: id,
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
        "SELECT id FROM audit_log WHERE id=? AND action IN ('approval_changed','active_changed','role_changed','application_rejected')",
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
          : input.action === "approve-patrols"
            ? await approveForPatrols(env.DB, actor, {
                userId: input.userId,
                version: input.version,
                eventId: input.eventId,
                notify: input.notify,
              })
            : input.action === "reject-application"
              ? await rejectApplication(env.DB, actor, {
                  userId: input.userId,
                  version: input.version,
                  reason: input.reason,
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
                    input.notify,
                  );
    const delivery = await actionEmailResult(
      bindings,
      result,
      input.action === "retry-notifications" ||
        input.action === "reject-application" ||
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
