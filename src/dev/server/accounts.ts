import type { BetterAuthPlugin } from "better-auth";
import {
  APIError,
  createAuthEndpoint,
  getSessionFromCtx,
} from "better-auth/api";
import {
  deleteSessionCookie,
  expireCookie,
  setSessionCookie,
} from "better-auth/cookies";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { createDatabase } from "../../server/db";
import { profile } from "../../server/db/schema";
import { loadApplicationProgress } from "../../server/db/application-progress";
import { RequestError, safeReturnTo } from "../../server/http";
import type { AuthBindings } from "../../server/auth";
import {
  accountStatePersona,
  manualAccountPresets,
  newApplicationPersona,
} from "../accounts";
import { deleteLocalAccount } from "./local-accounts";
import { resetAccountState } from "./account-states";
import { listLocalAccounts } from "./account-list";

export function developmentAccounts(bindings: AuthBindings) {
  const requireLocal = (request: Request | undefined) => {
    if (!request || !("env" in import.meta) || !import.meta.env.DEV)
      throw new APIError("NOT_FOUND", { message: "Not found" });
    const origin = request.headers.get("origin");
    const expectedOrigin = new URL(request.url).origin;
    if (
      (origin && origin !== expectedOrigin) ||
      (request.method === "POST" && origin !== expectedOrigin) ||
      request.headers.get("sec-fetch-site") === "cross-site"
    )
      throw new APIError("FORBIDDEN", { message: "Use the local website." });
  };
  return {
    id: "development-accounts" as const,
    endpoints: {
      developmentUsers: createAuthEndpoint(
        "/dev/users",
        {
          method: "GET",
          requireHeaders: true,
          query: z.object({ after: z.string().max(200).optional() }),
        },
        async (ctx) => {
          requireLocal(ctx.request);
          const accounts = await listLocalAccounts(
            bindings.DB,
            ctx.query.after,
          );
          const current = await getSessionFromCtx(ctx);
          return ctx.json({
            ...accounts,
            currentUserId: current?.user.id ?? null,
            currentAccountName: current?.user.name ?? null,
            applicationProgress: current
              ? await loadApplicationProgress(bindings.DB, current.user.id)
              : null,
          });
        },
      ),
      developmentSeedAccounts: createAuthEndpoint(
        "/dev/seed-accounts",
        {
          method: "POST",
          requireHeaders: true,
          body: z.strictObject({}),
        },
        async (ctx) => {
          requireLocal(ctx.request);
          const { seedLocalAccounts } = await import("./seed-accounts");
          try {
            await seedLocalAccounts(bindings);
          } catch (error) {
            throw new APIError("SERVICE_UNAVAILABLE", {
              message:
                error instanceof RequestError
                  ? error.message
                  : "Could not seed local accounts. Check local migrations and try again.",
            });
          }
          return ctx.json({
            message:
              "Local preset accounts and sample events are ready. Existing records and edits were preserved.",
          });
        },
      ),
      developmentSwitchUser: createAuthEndpoint(
        "/dev/switch-user",
        {
          method: "POST",
          requireHeaders: true,
          body: z
            .object({
              userId: z.string().min(1).max(200).nullable(),
              returnTo: z.string().max(1024).optional(),
            })
            .strict(),
        },
        async (ctx) => {
          requireLocal(ctx.request);
          const state = manualAccountPresets.find(
            (preset) => accountStatePersona(preset.key) === ctx.body.userId,
          );
          let userId = ctx.body.userId;
          if (userId === newApplicationPersona || state) {
            const cookie = ctx.context.createAuthCookie("development_state");
            const saved = await ctx.getSignedCookie(
              cookie.name,
              ctx.context.secret,
            );
            const parsed = z.uuid().safeParse(saved);
            const slot = parsed.success ? parsed.data : crypto.randomUUID();
            try {
              userId = await resetAccountState(
                bindings.DB,
                state?.key ?? "not-applied",
                slot,
              );
            } catch (error) {
              if (error instanceof RequestError)
                throw new APIError(
                  error.status === 409 ? "CONFLICT" : "BAD_REQUEST",
                  { message: error.message },
                );
              throw error;
            }
            await ctx.setSignedCookie(
              cookie.name,
              slot,
              ctx.context.secret,
              cookie.attributes,
            );
          }
          const person = userId
            ? await ctx.context.internalAdapter.findUserById(userId)
            : null;
          if (userId && !person)
            throw new APIError("NOT_FOUND", { message: "User not found." });
          const token = await ctx.getSignedCookie(
            ctx.context.authCookies.sessionToken.name,
            ctx.context.secret,
          );
          if (token) await ctx.context.internalAdapter.deleteSession(token);
          deleteSessionCookie(ctx);
          expireCookie(ctx, ctx.context.createAuthCookie("two_factor"));
          expireCookie(ctx, ctx.context.createAuthCookie("sign_in_return"));
          if (!person) return ctx.json({ next: "/volunteer" });
          const twoFactorVerified =
            "twoFactorEnabled" in person && person.twoFactorEnabled === true;
          // For saved users only the session changes. Never promote users, approve
          // patrols, or change email verification or authenticator enrollment in D1.
          const session = await ctx.context.internalAdapter.createSession(
            person.id,
            false,
            { twoFactorVerified },
            true,
          );
          if (!session)
            throw new APIError("INTERNAL_SERVER_ERROR", {
              message: "Could not switch accounts.",
            });
          await setSessionCookie(ctx, { session, user: person });
          const applicationSubmitted = await createDatabase(
            bindings.DB,
          ).query.profile.findFirst({
            where: eq(profile.user_id, person.id),
            columns: { user_id: true },
          });
          let next = state ? "/volunteer" : safeReturnTo(ctx.body.returnTo);
          if (!applicationSubmitted) next = "/apply";
          else if (/^\/apply\/?(?:\?|$)/.test(next))
            next = "/volunteer/account";
          else if (
            /^\/manage(?:\/|\?|$)/.test(next) &&
            !("role" in person && person.role === "organizer")
          )
            next = "/events";
          return ctx.json({ next });
        },
      ),
      developmentApplicationStep: createAuthEndpoint(
        "/dev/application-step",
        {
          method: "POST",
          requireHeaders: true,
          body: z.strictObject({
            userId: z.string().min(1).max(200),
            step: z.enum(["form", "naloxone", "discord", "review"]),
          }),
        },
        async (ctx) => {
          requireLocal(ctx.request);
          // Load after auth initialization: these helpers use the normal auth
          // context and must not introduce a cycle in the development plugin.
          const { accountContext } = await import("../../server/db/access");
          const { completeLocalApplicationStep } =
            await import("./application-steps");
          try {
            const { actor } = await accountContext(
              bindings,
              ctx.request!,
              true,
            );
            if (!actor) throw new RequestError(401, "Choose an account first.");
            if (actor.twoFactorEnabled && !actor.twoFactorVerified)
              throw new RequestError(
                403,
                "Sign in with your authenticator first.",
              );
            if (actor.id !== ctx.body.userId)
              throw new RequestError(
                409,
                "Your account changed. Reload before completing this step.",
              );
            await completeLocalApplicationStep(
              bindings.DB,
              actor,
              ctx.body.step,
            );
            return ctx.json({ next: "/volunteer" });
          } catch (error) {
            if (error instanceof RequestError)
              throw new APIError(
                error.status === 401
                  ? "UNAUTHORIZED"
                  : error.status === 403
                    ? "FORBIDDEN"
                    : error.status === 409
                      ? "CONFLICT"
                      : "BAD_REQUEST",
                { message: error.message },
              );
            throw error;
          }
        },
      ),
      developmentDeleteUser: createAuthEndpoint(
        "/dev/delete-user",
        {
          method: "POST",
          requireHeaders: true,
          body: z.strictObject({
            userId: z.string().min(1).max(200),
            confirm: z.literal(true),
          }),
        },
        async (ctx) => {
          requireLocal(ctx.request);
          const current = await getSessionFromCtx(ctx);
          let deleted: boolean;
          try {
            deleted = await deleteLocalAccount(bindings.DB, ctx.body.userId);
          } catch (error) {
            if (error instanceof RequestError && error.status === 403)
              throw new APIError("FORBIDDEN", { message: error.message });
            const reason =
              error instanceof Error
                ? `${error.message} ${error.cause instanceof Error ? error.cause.message : ""}`
                : "";
            throw new APIError("CONFLICT", {
              message: reason.includes("last_organizer")
                ? "Keep at least one active organizer. This local account was not deleted."
                : "Could not delete this local account. It may be referenced by organizer records.",
            });
          }
          if (!deleted)
            throw new APIError("NOT_FOUND", {
              message: "Local account not found.",
            });
          const deletedCurrent = current?.user.id === ctx.body.userId;
          if (deletedCurrent) {
            deleteSessionCookie(ctx);
            expireCookie(ctx, ctx.context.createAuthCookie("two_factor"));
            expireCookie(ctx, ctx.context.createAuthCookie("sign_in_return"));
          }
          return ctx.json({ next: deletedCurrent ? "/volunteer" : null });
        },
      ),
    },
  } satisfies BetterAuthPlugin;
}
