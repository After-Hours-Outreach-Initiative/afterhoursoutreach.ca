import { defineMiddleware } from "astro:middleware";
import { isWorkerPreview, accountsEnabled } from "@/data/environment";

export const onRequest = defineMiddleware(async (context, next) => {
  const response = await next();
  const privateRoute =
    /^\/(?:api\/(?:auth|account|events|organizer)(?:\/|$)|volunteer\/(?:account|register|sign-in|volunteers)(?:\/|$))/.test(
      context.url.pathname,
    ) ||
    (accountsEnabled && /^\/volunteer\/?$/.test(context.url.pathname));
  if (!isWorkerPreview && !privateRoute) return response;
  const headers = new Headers(response.headers);
  if (isWorkerPreview)
    headers.set("X-Robots-Tag", "noindex, nofollow, noarchive");
  headers.set("Cache-Control", "no-store");
  if (privateRoute) {
    headers.set("Referrer-Policy", "no-referrer");
    headers.set("X-Content-Type-Options", "nosniff");
    if (isWorkerPreview)
      headers.set(
        "Content-Security-Policy",
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; frame-src 'none'; connect-src 'self'; img-src 'self' data:; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self'",
      );
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
});
