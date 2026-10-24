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
import { asc, eq, gt } from "drizzle-orm";
import { z } from "zod";
import { createDatabase } from "../../server/db";
import { profile, user } from "../../server/db/schema";
import { RequestError, safeReturnTo } from "../../server/http";
import type { AuthBindings } from "../../server/auth";
import { newApplicationPersona } from "../accounts";
import { createDisposableAccount, deleteLocalAccount } from "./local-accounts";

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
          const db = createDatabase(bindings.DB);
          const rows = await db
            .select({
              id: user.id,
              name: user.name,
              email: user.email,
              role: user.role,
            })
            .from(user)
            .where(ctx.query.after ? gt(user.id, ctx.query.after) : undefined)
            .orderBy(asc(user.id))
            .limit(101);
          const current = await getSessionFromCtx(ctx);
          return ctx.json({
            users: rows.slice(0, 100),
            next: rows.length > 100 ? rows[99].id : null,
            currentUserId: current?.user.id ?? null,
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
          // Each selection gets its own empty, visible, deletable D1 identity.
          // Never clear/reuse the old Not applied fixture: it may be submitted.
          const userId =
            ctx.body.userId === newApplicationPersona
              ? await createDisposableAccount(bindings.DB)
              : ctx.body.userId;
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
          let next = safeReturnTo(ctx.body.returnTo);
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
