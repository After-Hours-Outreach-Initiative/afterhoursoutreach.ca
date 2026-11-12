import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { z } from "zod";
import { forwardCookies } from "@/server/auth";
import {
  accountContext,
  requireOrganizer,
  writePermission,
  permissionValues,
} from "@/server/db/access";
import { errorResponse, readJson, RequestError } from "@/server/http";

export const prerender = false;
export const POST: APIRoute = async ({ request }) => {
  try {
    const { actor, headers } = await accountContext(env, request, true);
    requireOrganizer(actor);
    const parsed = z
      .object({ userId: z.string(), applicationReviewEmails: z.boolean() })
      .safeParse(await readJson(request, 4096));
    if (!parsed.success)
      throw new RequestError(400, "Choose your email notification preference.");
    if (parsed.data.userId !== actor.id)
      throw new RequestError(
        403,
        "Your account changed. Reload before continuing.",
      );
    const result = await env.DB.prepare(
      `UPDATE user SET application_review_emails=? WHERE id=? AND ${writePermission(true)}`,
    )
      .bind(
        Number(parsed.data.applicationReviewEmails),
        actor.id,
        ...permissionValues(actor),
      )
      .run();
    if (!result.meta.changes)
      throw new RequestError(403, "Organizer access is required.");
    const response = Response.json(
      { message: "Email notifications saved." },
      { headers: { "Cache-Control": "no-store" } },
    );
    forwardCookies(headers, response.headers);
    return response;
  } catch (error) {
    return errorResponse(error);
  }
};
