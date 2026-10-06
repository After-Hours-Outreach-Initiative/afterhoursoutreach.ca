import { defineMiddleware } from "astro:middleware";

export const onRequest = defineMiddleware(async (context, next) => {
  const response = await next();
  const privateRoute =
    /^\/(?:api\/(?:auth|account|events|organizer)(?:\/|$)|volunteer(?:\/|$)|privacy\/?$)/.test(
      context.url.pathname,
    );
  if (!privateRoute) return response;
  const headers = new Headers(response.headers);
  headers.set("X-Robots-Tag", "noindex, nofollow, noarchive");
  headers.set("Cache-Control", "no-store");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("X-Content-Type-Options", "nosniff");
  // Vite's development tools need inline scripts and WebSocket connections.
  if (!import.meta.env.DEV)
    headers.set(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; frame-src 'none'; connect-src 'self'; img-src 'self' data:; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self'",
    );
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
});
