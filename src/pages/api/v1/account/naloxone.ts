import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { forwardCookies } from "@/server/auth";
import { accountContext } from "@/server/db/access";
import { confirmNaloxoneCompletion } from "@/server/db/naloxone";
import { submissionNotificationStatements } from "@/server/db/submission-notifications";
import { runSubmissionNotificationJob } from "@/server/submission-notifications";
import { takeRateLimit } from "@/server/db/rate-limits";
import { errorResponse, readJson, RequestError } from "@/server/http";

export const prerender = false;
export const POST: APIRoute = async ({ request, locals }) => {
  try {
    const { actor, headers } = await accountContext(env, request, true);
    if (!actor)
      throw new RequestError(401, "Sign in to confirm course completion.");
    if (actor.twoFactorEnabled && !actor.twoFactorVerified)
      throw new RequestError(
        403,
        "Sign in with your authenticator to confirm course completion.",
      );
    await takeRateLimit(
      env.DB,
      env.BETTER_AUTH_SECRET,
      `naloxone-user:${actor.id}`,
      20,
      60_000,
    );
    const result = await confirmNaloxoneCompletion(
      env.DB,
      actor,
      await readJson(request, 1024),
      { reviewStatements: submissionNotificationStatements(env) },
    );
    if (result.reviewOperationId) {
      try {
        locals.cfContext.waitUntil(
          runSubmissionNotificationJob(env, {
            operationId: result.reviewOperationId,
            limit: 3,
            timeoutMs: 20_000,
          }),
        );
      } catch {
        // The committed outbox survives scheduling failure; the hourly cron retries.
        console.error(
          JSON.stringify({
            event: "application_submission_notifications",
            error: "scheduling_unavailable",
          }),
        );
      }
    }
    const response = Response.json(
      {
        completedAt: result.completedAt,
        message: "Completion saved to your account.",
      },
      { headers: { "Cache-Control": "no-store" } },
    );
    forwardCookies(headers, response.headers);
    return response;
  } catch (error) {
    return errorResponse(error);
  }
};
