import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { forwardCookies } from "@/server/auth";
import { accountContext } from "@/server/db/access";
import { z } from "zod";
import type { ApplicationAnswers } from "@/data/application";
import { saveProfile } from "@/server/db/profiles";
import { takeRateLimit } from "@/server/db/rate-limits";
import { errorResponse, readJson, RequestError } from "@/server/http";

export const prerender = false;
export const POST: APIRoute = async ({ request }) => {
  try {
    const { actor, headers } = await accountContext(env, request, true);
    if (!actor) throw new RequestError(401, "Sign in to edit your profile.");
    if (actor.twoFactorEnabled && !actor.twoFactorVerified)
      throw new RequestError(
        403,
        "Sign in with your authenticator to edit your profile.",
      );
    await takeRateLimit(
      env.DB,
      env.BETTER_AUTH_SECRET,
      `profile-user:${actor.id}`,
      20,
      60_000,
    );
    const input = await readJson(request, 131_072);
    const parsed = z
      .object({
        applicationUserId: z.string(),
        intent: z.enum(["submit", "edit"]),
        baseline: z
          .record(z.string(), z.union([z.string(), z.array(z.string())]))
          .optional(),
        draft: z
          .object({
            revision: z.uuid().nullable(),
            generation: z.uuid().nullable(),
          })
          .optional(),
      })
      .safeParse(input);
    if (!parsed.success)
      throw new RequestError(428, "Reload this page before saving.");
    const { applicationUserId, intent, baseline, draft } = parsed.data;
    if (applicationUserId !== actor.id)
      throw new RequestError(
        403,
        "Your account changed. Reload before continuing.",
      );
    if (intent === "submit" && !draft)
      throw new RequestError(428, "Reload before submitting your application.");
    const answers = { ...(input as Record<string, unknown>) };
    for (const key of ["applicationUserId", "intent", "baseline", "draft"])
      delete answers[key];
    const saved = await saveProfile(env.DB, actor.id, answers, {
      actor,
      intent,
      baseline: baseline as ApplicationAnswers | undefined,
      draft,
    });
    const response = Response.json(
      {
        ...saved,
        next: "/volunteer/account",
        message: saved.alreadySubmitted
          ? "Your application was already submitted. The submitted answers have not been replaced."
          : "Profile saved.",
      },
      { headers: { "Cache-Control": "no-store" } },
    );
    forwardCookies(headers, response.headers);
    return response;
  } catch (error) {
    return errorResponse(error);
  }
};
