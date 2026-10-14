import type { APIRoute } from "astro";

export const prerender = false;

// Keep old bookmarks working without forwarding form submissions or return URLs.
export const GET: APIRoute = ({ redirect }) => redirect("/apply", 301);
export const HEAD = GET;
export const ALL: APIRoute = () =>
  new Response(null, { status: 405, headers: { Allow: "GET, HEAD" } });
