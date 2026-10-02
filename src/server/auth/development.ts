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
import { createDatabase } from "../db";
import { profile, user } from "../db/schema";
import { isLocalDevelopment } from "../development";
import { safeReturnTo } from "../http";
import type { AuthBindings } from "./index";

export function developmentAccounts(bindings: AuthBindings) {
  const requireLocal = (request: Request | undefined) => {
    if (!request || !isLocalDevelopment(bindings, request))
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
    id: "development-accounts",
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
          const person = ctx.body.userId
            ? await createDatabase(bindings.DB).query.user.findFirst({
                where: eq(user.id, ctx.body.userId),
              })
            : null;
          if (ctx.body.userId && !person)
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
          // Only the session changes. Never promote users, approve patrols, or
          // change their email verification or authenticator enrollment in D1.
          const session = await ctx.context.internalAdapter.createSession(
            person.id,
            false,
            { twoFactorVerified: person.twoFactorEnabled === true },
            true,
          );
          if (!session)
            throw new APIError("INTERNAL_SERVER_ERROR", {
              message: "Could not switch accounts.",
            });
          await setSessionCookie(ctx, { session, user: person });
          const registered = await createDatabase(
            bindings.DB,
          ).query.profile.findFirst({
            where: eq(profile.userId, person.id),
            columns: { userId: true },
          });
          let next = safeReturnTo(ctx.body.returnTo);
          if (!registered) next = "/volunteer/register";
          else if (next.startsWith("/volunteer/register"))
            next = "/volunteer/account";
          else if (
            next.startsWith("/volunteer/volunteers") &&
            person.role !== "organizer"
          )
            next = "/volunteer";
          return ctx.json({ next });
        },
      ),
    },
  } satisfies BetterAuthPlugin;
}
