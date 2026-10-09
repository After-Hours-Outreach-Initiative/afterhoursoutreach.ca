import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { authBindingsForRequest, createAuth } from "@/server/auth";
import { takeRateLimit } from "@/server/db/rate-limits";
import {
  errorResponse,
  readJson,
  requireSameOrigin,
  RequestError,
} from "@/server/http";

export const prerender = false;

const allowed = new Map([
  ["/email-otp/send-verification-otp", "POST"],
  ["/sign-in/email-otp", "POST"],
  ["/email-otp/request-email-change", "POST"],
  ["/email-otp/change-email", "POST"],
  ["/get-session", "GET"],
  ["/sign-out", "POST"],
  ["/two-factor/enable", "POST"],
  ["/two-factor/verify-totp", "POST"],
  ["/two-factor/verify-backup-code", "POST"],
  ...(import.meta.env.DEV
    ? ([
        ["/dev/users", "GET"],
        ["/dev/switch-user", "POST"],
      ] as const)
    : []),
]);

export const ALL: APIRoute = async ({ request, clientAddress }) => {
  const path = new URL(request.url).pathname.replace(/^\/api\/v1\/auth/, "");
  if (path.startsWith("/dev/") && !import.meta.env.DEV)
    return new Response("Not found", { status: 404 });
  if (!allowed.has(path)) return new Response("Not found", { status: 404 });
  if (request.method !== allowed.get(path))
    return new Response("Method not allowed", { status: 405 });
  try {
    const bindings = authBindingsForRequest(env, request);
    const origin = new URL(bindings.AUTH_BASE_URL).origin;
    if (request.method === "POST") requireSameOrigin(request, origin);
    const ip = request.headers.get("cf-connecting-ip") ?? clientAddress;
    const auth = createAuth(bindings, ip);
    await takeRateLimit(
      env.DB,
      env.BETTER_AUTH_SECRET,
      `auth-ip:${ip}`,
      120,
      60_000,
    );
    let input = request;
    if (request.method === "POST") {
      const body = await readJson(request);
      if (path.startsWith("/two-factor/")) {
        await takeRateLimit(
          env.DB,
          env.BETTER_AUTH_SECRET,
          `2fa-ip:${ip}`,
          5,
          60_000,
        );
        if (typeof body === "object" && body && "trustDevice" in body)
          throw new RequestError(400, "Trusted devices are not supported.");
      }
      input = new Request(request.url, {
        method: request.method,
        headers: request.headers,
        body: JSON.stringify(body),
      });
    }
    const response = await auth.handler(input);
    response.headers.set("Cache-Control", "no-store");
    if (response.status === 429) response.headers.set("Retry-After", "60");
    return response;
  } catch (error) {
    return errorResponse(error);
  }
};
