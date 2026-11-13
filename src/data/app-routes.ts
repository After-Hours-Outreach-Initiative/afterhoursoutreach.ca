/** Signed-in screens that navigate through the client router and its cache. */
export const appRoutes: ReadonlySet<string> = new Set([
  "/events",
  "/volunteer",
  "/applications",
  "/volunteers",
  "/volunteer/account",
]);

/** Matches with or without a trailing slash. */
export const isAppRoute = (pathname: string) =>
  appRoutes.has(pathname.replace(/(.)\/$/, "$1"));
