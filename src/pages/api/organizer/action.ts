import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { z } from "zod";
import { accountsEnabled } from "@/data/environment";
import { accountContext, requireOrganizer } from "@/server/accounts/access";
import {
  setVolunteerStatus,
  setRole,
  completeOrientation,
  statusSchema,
} from "@/server/accounts/organizers";
import { forwardCookies } from "@/server/auth";
import { takeRateLimit } from "@/server/auth/abuse";
import { deliverNotifications } from "@/server/events/notifications";
import { readJson, RequestError, errorResponse } from "@/server/http";

const id = z.string().min(1).max(200);
const inputSchema = z.discriminatedUnion("action", [
  statusSchema.extend({ action: z.literal("status") }),
  z.strictObject({
    action: z.literal("role"),
    userId: id,
    role: z.enum(["volunteer", "organizer"]),
  }),
  z.strictObject({ action: z.literal("orientation"), userId: id, eventId: id }),
]);
export const prerender = false;
export const POST: APIRoute = async ({ request }) => {
  if (!accountsEnabled) return new Response("Not found", { status: 404 });
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
    const result =
      input.action === "status"
        ? await setVolunteerStatus(env.DB, actor, {
            userId: input.userId,
            version: input.version,
            active: input.active,
            patrolApproved: input.patrolApproved,
          })
        : input.action === "role"
          ? await setRole(env.DB, actor, input.userId, input.role)
          : await completeOrientation(
              env.DB,
              actor,
              input.userId,
              input.eventId,
            );
    let delivery;
    try {
      delivery = await deliverNotifications(bindings, result.operation);
    } catch {
      delivery = { failed: 1, sent: 0, pending: 1 };
    }
    const response = Response.json(
      {
        ...delivery,
        message: `${result.message}${delivery.pending ? " Some notifications are awaiting delivery; an organizer can retry them." : ""}`,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
    forwardCookies(headers, response.headers);
    return response;
  } catch (error) {
    return errorResponse(error);
  }
};
