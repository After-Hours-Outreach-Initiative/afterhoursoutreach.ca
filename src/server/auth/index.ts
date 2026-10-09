import { betterAuth, type BetterAuthPlugin } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { expireCookie } from "better-auth/cookies";
import { emailOTP } from "better-auth/plugins/email-otp";
import { twoFactor } from "better-auth/plugins/two-factor";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { z } from "zod";
import { createDatabase } from "../db";
import * as schema from "../db/schema";
import { RequestError, safeReturnTo } from "../http";
import {
  cleanupAuthRecords,
  limitEmailRequests,
  limitEmailVerification,
} from "../db/rate-limits";
import { isRegistered } from "../db/profiles";
import { markSessionSecondFactorVerified } from "../db/sessions";
import { sendSignInEmail, type SignInEmail } from "./services";

// A build-time gate keeps the development plugin out of deployed Workers.
// Direct .DEV access lets Vite replace the flag; the property check also keeps
// this module importable in Node tests, which have no Vite environment object.
const development = "env" in import.meta && import.meta.env.DEV;
let developmentAccounts:
  typeof import("../../dev/server/accounts").developmentAccounts | undefined;
if ("env" in import.meta) {
  if (import.meta.env.DEV) {
    developmentAccounts = (await import("../../dev/server/accounts"))
      .developmentAccounts;
  }
}

export type AuthBindings = Pick<
  Env,
  "DB" | "APP_ENV" | "AUTH_BASE_URL" | "BETTER_AUTH_SECRET" | "RESEND_API_KEY"
>;

/** Never trust forwarded hosts or mutate the shared runtime bindings. */
export function authBindingsForRequest(
  bindings: AuthBindings,
  request: Request,
) {
  const url = new URL(request.url);
  const local = development;
  // Pin hosted sign-in links to AUTH_BASE_URL when configured. Otherwise use
  // the URL routed to this Worker, not Host or X-Forwarded-Host headers.
  const origin =
    local || !bindings.AUTH_BASE_URL
      ? url.origin
      : new URL(bindings.AUTH_BASE_URL).origin;
  if ((!local && url.protocol !== "https:") || url.origin !== origin)
    throw new RequestError(403, "This request does not match the site origin.");
  return {
    ...bindings,
    AUTH_BASE_URL: origin,
  };
}

// Dependency injection is for server-side tests, never a request or env bypass.
interface AuthServices {
  sendEmail: (email: SignInEmail) => Promise<void | SignInEmail>;
}

const emailSchema = z.string().trim().toLowerCase().pipe(z.email().max(254));
const requestSchema = z.strictObject({
  email: emailSchema,
  type: z.literal("sign-in"),
});
const verifySchema = z.strictObject({
  email: emailSchema,
  otp: z.string().regex(/^\d{6}$/),
});
const signInResultSchema = z.looseObject({
  token: z.string(),
  user: z.looseObject({ id: z.string() }),
});

function authError(error: unknown): never {
  if (error instanceof RequestError)
    throw new APIError(
      error.status === 429 ? "TOO_MANY_REQUESTS" : "SERVICE_UNAVAILABLE",
      { message: error.message },
    );
  throw error;
}

function signInReturnTo(query: Record<string, unknown> | undefined) {
  const value = query?.returnTo;
  return safeReturnTo(
    typeof value === "string" && value.length <= 1024 ? value : undefined,
  );
}

/** Construct with the current request's D1 binding, never a module singleton. */
export function createAuth(
  bindings: AuthBindings,
  ip = "unknown",
  overrides?: AuthServices,
) {
  if (!bindings.BETTER_AUTH_SECRET || bindings.BETTER_AUTH_SECRET.length < 32)
    throw new RequestError(503, "Sign-in is not configured yet.");
  const origin = new URL(bindings.AUTH_BASE_URL).origin;
  const db = createDatabase(bindings.DB);
  const services: AuthServices = overrides ?? {
    sendEmail: (email) =>
      sendSignInEmail(bindings.RESEND_API_KEY, email, bindings.APP_ENV),
  };
  // Request-scoped delivery feedback; never a shared outbox or public proof.
  const emailDeliveries = new WeakMap<
    object,
    { localEmail?: SignInEmail } | { error: string }
  >();
  const emailSignIn = emailOTP({
    expiresIn: 600,
    allowedAttempts: 3,
    storeOTP: "hashed",
    async sendVerificationOTP({ email, otp }, ctx) {
      const url = new URL("/volunteer/sign-in/complete", origin);
      // Fragments keep the email and OTP out of HTTP request URLs/referrers.
      url.hash = new URLSearchParams({
        email,
        otp,
        returnTo: signInReturnTo(ctx?.query),
      }).toString();
      try {
        const localEmail = await services.sendEmail({
          id: crypto.randomUUID(),
          email,
          code: otp,
          url: url.href,
        });
        if (development && localEmail && ctx)
          emailDeliveries.set(ctx.context, { localEmail });
      } catch (error) {
        // Better Auth intentionally swallows delivery callback errors. Keep a
        // sanitized outcome for the after hook so the form can still report failure.
        if (ctx)
          emailDeliveries.set(ctx.context, {
            error:
              error instanceof RequestError
                ? error.message
                : "We could not send the email. Try again later.",
          });
        // An undelivered code must not remain usable.
        await ctx?.context.internalAdapter.deleteVerificationByIdentifier(
          `sign-in-otp-${email}`,
        );
        if (!ctx) authError(error);
      }
    },
  });
  const secondFactor = twoFactor({
    allowPasswordless: true,
    issuer: "After Hours Outreach",
    schema: {
      user: { fields: { twoFactorEnabled: "two_factor_enabled" } },
      twoFactor: {
        fields: {
          userId: "user_id",
          backupCodes: "backup_codes",
          failedVerificationCount: "failed_verification_count",
          lockedUntil: "locked_until",
        },
      },
    },
  });
  // Better Auth does not gate passwordless sign-ins by default. Reuse its
  // challenge/cookie/lockout handling, preserving its built-in sign-in routes.
  // Fail closed if an upgrade changes the plugin's single challenge-hook contract.
  const challengeHooks = secondFactor.hooks.after;
  if (challengeHooks.length !== 1)
    throw new Error("Review the Better Auth two-factor sign-in integration.");
  secondFactor.hooks.after = challengeHooks.map((hook) => ({
    ...hook,
    matcher: (context) =>
      context.path === "/sign-in/email-otp" || hook.matcher(context),
  }));

  const verificationMarker = {
    id: "verified-second-factor",
    hooks: {
      after: [
        {
          matcher: (ctx) =>
            ctx.path === "/two-factor/verify-totp" ||
            ctx.path === "/two-factor/verify-backup-code",
          handler: createAuthMiddleware(async (ctx) => {
            const result = signInResultSchema.safeParse(ctx.context.returned);
            if (!result.success) return;
            const token =
              ctx.context.newSession?.session.token ?? result.data.token;
            await markSessionSecondFactorVerified(bindings.DB, token);
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
    basePath: "/api/v1/auth",
    secret: bindings.BETTER_AUTH_SECRET,
    database: drizzleAdapter(db, {
      provider: "sqlite",
      schema,
      transaction: false,
    }),
    trustedOrigins: [origin],
    emailAndPassword: { enabled: false },
    user: {
      // Better Auth keeps its API field names; Drizzle uses the SQL names.
      fields: {
        emailVerified: "email_verified",
        createdAt: "created_at",
        updatedAt: "updated_at",
      },
      additionalFields: {
        role: {
          type: ["volunteer", "organizer"],
          defaultValue: "volunteer",
          input: false,
        },
      },
    },
    session: {
      fields: {
        userId: "user_id",
        expiresAt: "expires_at",
        ipAddress: "ip_address",
        userAgent: "user_agent",
        createdAt: "created_at",
        updatedAt: "updated_at",
      },
      expiresIn: 30 * 86_400,
      updateAge: 86_400,
      cookieCache: { enabled: false },
      additionalFields: {
        twoFactorVerified: {
          type: "boolean",
          fieldName: "two_factor_verified",
          defaultValue: false,
          input: false,
        },
      },
    },
    account: {
      fields: {
        userId: "user_id",
        accountId: "account_id",
        providerId: "provider_id",
        accessToken: "access_token",
        refreshToken: "refresh_token",
        idToken: "id_token",
        accessTokenExpiresAt: "access_token_expires_at",
        refreshTokenExpiresAt: "refresh_token_expires_at",
        createdAt: "created_at",
        updatedAt: "updated_at",
      },
    },
    verification: {
      fields: {
        expiresAt: "expires_at",
        createdAt: "created_at",
        updatedAt: "updated_at",
      },
    },
    advanced: {
      useSecureCookies: origin.startsWith("https://"),
      cookiePrefix: "aho",
      defaultCookieAttributes: { httpOnly: true, sameSite: "lax", path: "/" },
      ipAddress: { ipAddressHeaders: ["cf-connecting-ip"] },
    },
    // The public route uses atomic D1 limits instead of isolate-local memory.
    rateLimit: { enabled: false },
    // Avoid Better Auth's default error logs exposing adapter values.
    logger: { disabled: true },
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        const sending = ctx.path === "/email-otp/send-verification-otp";
        if (!sending && ctx.path !== "/sign-in/email-otp") return;
        const parsed = (sending ? requestSchema : verifySchema).safeParse(
          ctx.body,
        );
        if (!parsed.success)
          throw new APIError("BAD_REQUEST", {
            message: "Enter a valid email address and sign-in code.",
          });
        try {
          if (sending) {
            await limitEmailRequests(
              bindings.DB,
              bindings.BETTER_AUTH_SECRET,
              parsed.data.email,
              ip,
            );
            await cleanupAuthRecords(bindings.DB);
          } else {
            await limitEmailVerification(
              bindings.DB,
              bindings.BETTER_AUTH_SECRET,
              parsed.data.email,
              ip,
            );
          }
        } catch (error) {
          authError(error);
        }
        return { context: { body: parsed.data } };
      }),
      after: createAuthMiddleware(async (ctx) => {
        if (ctx.path === "/email-otp/send-verification-otp") {
          const delivery = emailDeliveries.get(ctx.context);
          if (delivery && "error" in delivery)
            return Response.json({ message: delivery.error }, { status: 503 });
          if (development && delivery?.localEmail)
            return ctx.json({
              success: true,
              localEmail: delivery.localEmail,
            });
          return;
        }
        if (ctx.path !== "/sign-in/email-otp") return;
        const current = ctx.context.newSession;
        const result = signInResultSchema.safeParse(ctx.context.returned);
        if (!current || !result.success) return;
        const registered = await isRegistered(bindings.DB, current.user.id);
        const next = registered
          ? signInReturnTo(ctx.query)
          : "/volunteer/register";
        // This hook runs before the two-factor plugin replaces the session
        // with a pending challenge for accounts that opted into an authenticator.
        if (current.user.twoFactorEnabled) {
          const cookie = ctx.context.createAuthCookie("sign_in_return", {
            maxAge: 600,
          });
          await ctx.setSignedCookie(
            cookie.name,
            JSON.stringify({ userId: current.user.id, next }),
            ctx.context.secret,
            cookie.attributes,
          );
        }
        return ctx.json({ ...result.data, next });
      }),
    },
    plugins: [
      emailSignIn,
      secondFactor,
      verificationMarker,
      ...(developmentAccounts ? [developmentAccounts(bindings)] : []),
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
