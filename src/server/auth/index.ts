import { betterAuth, type BetterAuthPlugin } from "better-auth";
import {
  APIError,
  createAuthEndpoint,
  createAuthMiddleware,
} from "better-auth/api";
import { expireCookie, setSessionCookie } from "better-auth/cookies";
import { twoFactor } from "better-auth/plugins/two-factor";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { createDatabase } from "../db";
import * as schema from "../db/schema";
import { RequestError, safeReturnTo } from "../http";
import { cleanupAuthRecords, limitEmailRequests } from "./abuse";
import { consumeEmailChallenge, createEmailChallenge } from "./challenge";
import { sendSignInEmail, type SignInEmail } from "./services";
import { developmentAccounts } from "./development";
import { isLocalDevelopment } from "../development";

export type AuthBindings = Pick<
  Env,
  | "DB"
  | "APP_ENV"
  | "AUTH_BASE_URL"
  | "PREVIEW_HOST_SUFFIX"
  | "BETTER_AUTH_SECRET"
  | "RESEND_API_KEY"
>;

/** Never trust forwarded hosts or mutate the shared runtime bindings. */
export function authBindingsForRequest(
  bindings: AuthBindings,
  request: Request,
) {
  if (isLocalDevelopment(bindings, request))
    return {
      ...bindings,
      AUTH_BASE_URL: new URL(request.url).origin,
    };
  if (bindings.APP_ENV !== "preview") return bindings;
  const url = new URL(request.url);
  const suffix = bindings.PREVIEW_HOST_SUFFIX;
  const prefix =
    suffix && url.hostname.endsWith(suffix)
      ? url.hostname.slice(0, -suffix.length)
      : "";
  if (
    url.protocol !== "https:" ||
    url.port ||
    url.username ||
    url.password ||
    url.hostname.split(".")[0].length > 63 ||
    !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(prefix)
  )
    throw new RequestError(403, "This is not an approved preview hostname.");
  return {
    ...bindings,
    AUTH_BASE_URL: url.origin,
  };
}

// Dependency injection is for server-side tests, never a request or env bypass.
interface AuthServices {
  sendEmail: (email: SignInEmail) => Promise<void | SignInEmail>;
}

const requestSchema = z.object({
  email: z
    .email()
    .max(254)
    .transform((value) => value.trim().toLowerCase()),
  returnTo: z.string().max(1024).optional(),
});
const verifySchema = z.union([
  z.object({ id: z.uuid(), code: z.string().regex(/^\d{6}$/) }).strict(),
  z
    .object({ id: z.uuid(), token: z.string().regex(/^[a-f0-9]{64}$/) })
    .strict(),
]);

function emailSignIn(
  bindings: AuthBindings,
  ip: string,
  services: AuthServices,
) {
  return {
    id: "email-link-and-code",
    endpoints: {
      requestEmail: createAuthEndpoint(
        "/email/request",
        { method: "POST", requireHeaders: true, body: requestSchema },
        async (ctx) => {
          try {
            await limitEmailRequests(
              bindings.DB,
              bindings.BETTER_AUTH_SECRET,
              ctx.body.email,
              ip,
            );
            await cleanupAuthRecords(bindings.DB);
            const challenge = await createEmailChallenge(
              bindings.DB,
              bindings.BETTER_AUTH_SECRET,
              ctx.body.email,
              ctx.body.returnTo,
            );
            // Fragments are not transmitted in HTTP requests or referrers.
            const url = new URL(
              "/volunteer/sign-in/complete",
              bindings.AUTH_BASE_URL,
            );
            url.hash = new URLSearchParams({
              id: challenge.id,
              token: challenge.token,
            }).toString();
            let localEmail: void | SignInEmail;
            try {
              localEmail = await services.sendEmail({
                ...challenge,
                email: ctx.body.email,
                url: url.href,
              });
            } catch (error) {
              await createDatabase(bindings.DB)
                .delete(schema.emailChallenge)
                .where(eq(schema.emailChallenge.id, challenge.id));
              throw error;
            }
            return ctx.json({
              id: challenge.id,
              // Never expose sign-in proofs in a public build or preview.
              ...(import.meta.env?.DEV && bindings.APP_ENV === "local"
                ? { localEmail }
                : {}),
            });
          } catch (error) {
            if (error instanceof RequestError) {
              const status =
                error.status === 429
                  ? "TOO_MANY_REQUESTS"
                  : error.status === 403
                    ? "FORBIDDEN"
                    : "SERVICE_UNAVAILABLE";
              throw new APIError(status, { message: error.message });
            }
            throw error;
          }
        },
      ),
      verifyEmail: createAuthEndpoint(
        "/email/verify",
        { method: "POST", requireHeaders: true, body: verifySchema },
        async (ctx) => {
          const challenge = await consumeEmailChallenge(
            bindings.DB,
            bindings.BETTER_AUTH_SECRET,
            ctx.body.id,
            ctx.body,
          );
          if (!challenge)
            throw new APIError("UNAUTHORIZED", {
              message:
                "That link or code is invalid, expired, or already used.",
            });
          let found = await ctx.context.internalAdapter.findUserByEmail(
            challenge.email,
          );
          if (!found) {
            try {
              await ctx.context.internalAdapter.createUser(
                {
                  email: challenge.email,
                  emailVerified: true,
                  name: "",
                },
                { method: "email-link-and-code" },
              );
            } catch (error) {
              // Two independently requested emails may be verified concurrently.
              // The unique email index decides which request creates the user.
              if (
                !(await ctx.context.internalAdapter.findUserByEmail(
                  challenge.email,
                ))
              )
                throw error;
            }
            found = await ctx.context.internalAdapter.findUserByEmail(
              challenge.email,
            );
          }
          if (!found)
            throw new APIError("INTERNAL_SERVER_ERROR", {
              message: "Could not create account.",
            });
          let user = found.user;
          if (!user.emailVerified) {
            await createDatabase(bindings.DB)
              .delete(schema.session)
              .where(eq(schema.session.userId, user.id));
            user = await ctx.context.internalAdapter.updateUser(user.id, {
              emailVerified: true,
            });
          }
          const session = await ctx.context.internalAdapter.createSession(
            user.id,
          );
          if (!session)
            throw new APIError("INTERNAL_SERVER_ERROR", {
              message: "Could not create session.",
            });
          await setSessionCookie(ctx, { session, user });
          const registered = await createDatabase(
            bindings.DB,
          ).query.profile.findFirst({
            where: eq(schema.profile.userId, user.id),
            columns: { userId: true },
          });
          const next = registered ? challenge.returnTo : "/volunteer/register";
          if ("twoFactorEnabled" in user && user.twoFactorEnabled === true) {
            const cookie = ctx.context.createAuthCookie("sign_in_return", {
              maxAge: 600,
            });
            await ctx.setSignedCookie(
              cookie.name,
              JSON.stringify({ userId: user.id, next }),
              ctx.context.secret,
              cookie.attributes,
            );
          }
          return ctx.json({ next });
        },
      ),
    },
  } satisfies BetterAuthPlugin;
}

/** Construct with the current request's D1 binding, never a module singleton. */
export function createAuth(
  bindings: AuthBindings,
  ip = "unknown",
  overrides?: AuthServices,
) {
  if (import.meta.env?.DEV && bindings.APP_ENV !== "local")
    throw new RequestError(
      503,
      "Local account testing requires APP_ENV=local.",
    );
  if (!bindings.BETTER_AUTH_SECRET || bindings.BETTER_AUTH_SECRET.length < 32)
    throw new RequestError(503, "Sign-in is not configured yet.");
  const origin = new URL(bindings.AUTH_BASE_URL).origin;
  const preview = bindings.APP_ENV === "preview";
  const db = createDatabase(bindings.DB);
  const services: AuthServices = overrides ?? {
    sendEmail: (email) =>
      sendSignInEmail(bindings.RESEND_API_KEY, email, bindings.APP_ENV),
  };
  const secondFactor = twoFactor({
    allowPasswordless: true,
    issuer: "After Hours Outreach",
  });
  // Better Auth does not gate passwordless sign-ins by default. Reuse its
  // challenge/cookie/lockout handling for our combined link-and-code endpoint.
  secondFactor.hooks.after[0].matcher = (context) =>
    context.path === "/email/verify";

  const verificationMarker = {
    id: "verified-second-factor",
    hooks: {
      after: [
        {
          matcher: (ctx) =>
            ctx.path === "/two-factor/verify-totp" ||
            ctx.path === "/two-factor/verify-backup-code",
          handler: createAuthMiddleware(async (ctx) => {
            const result = z
              .looseObject({
                token: z.string(),
                user: z.looseObject({ id: z.string() }),
              })
              .safeParse(ctx.context.returned);
            if (!result.success) return;
            const token =
              ctx.context.newSession?.session.token ?? result.data.token;
            await db
              .update(schema.session)
              .set({ twoFactorVerified: true })
              .where(eq(schema.session.token, token));
            const cookie = ctx.context.createAuthCookie("sign_in_return");
            const value = await ctx.getSignedCookie(
              cookie.name,
              ctx.context.secret,
            );
            expireCookie(ctx, cookie);
            let next = "/volunteer/account";
            if (value) {
              try {
                const redirect = z
                  .object({ userId: z.string(), next: z.string() })
                  .parse(JSON.parse(value));
                if (redirect.userId === result.data.user.id)
                  next = safeReturnTo(redirect.next);
              } catch {
                // A stale or malformed redirect cookie never affects sign-in.
              }
            }
            return ctx.json({ ...result.data, next });
          }),
        },
      ],
    },
  } satisfies BetterAuthPlugin;

  return betterAuth({
    appName: "After Hours Outreach",
    baseURL: origin,
    secret: bindings.BETTER_AUTH_SECRET,
    database: drizzleAdapter(db, {
      provider: "sqlite",
      schema,
      transaction: false,
    }),
    trustedOrigins: [origin],
    emailAndPassword: { enabled: false },
    user: {
      additionalFields: {
        role: {
          type: ["volunteer", "organizer"],
          defaultValue: "volunteer",
          input: false,
        },
      },
    },
    session: {
      expiresIn: 30 * 86_400,
      updateAge: 86_400,
      cookieCache: { enabled: false },
      additionalFields: {
        twoFactorVerified: {
          type: "boolean",
          defaultValue: false,
          input: false,
        },
      },
    },
    advanced: {
      useSecureCookies: origin.startsWith("https://"),
      cookiePrefix: preview ? "aho-preview" : "aho",
      defaultCookieAttributes: { httpOnly: true, sameSite: "lax", path: "/" },
      ipAddress: { ipAddressHeaders: ["cf-connecting-ip"] },
    },
    // The public route uses atomic D1 limits instead of isolate-local memory.
    rateLimit: { enabled: false },
    // Avoid Better Auth's default error logs exposing adapter values.
    logger: { disabled: true },
    plugins: [
      emailSignIn(bindings, ip, services),
      secondFactor,
      verificationMarker,
      ...(import.meta.env?.DEV && bindings.APP_ENV === "local"
        ? [developmentAccounts(bindings)]
        : []),
    ],
  });
}

export type AccountAuth = ReturnType<typeof createAuth>;

export async function readAccountSession(auth: AccountAuth, request: Request) {
  return auth.api.getSession({ headers: request.headers, returnHeaders: true });
}

export function forwardCookies(source: Headers, target: Headers) {
  for (const cookie of source.getSetCookie())
    target.append("Set-Cookie", cookie);
}
