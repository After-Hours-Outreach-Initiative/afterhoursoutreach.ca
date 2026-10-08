/** @param {Record<string, string | undefined>} [environment] */
export function playwrightTarget(environment = process.env) {
  const value = environment.PLAYWRIGHT_BASE_URL;
  if (!value)
    throw new Error(
      "Run pnpm test:ui to start an isolated local test database.",
    );
  const url = new URL(value);
  if (
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new Error(
      "PLAYWRIGHT_BASE_URL must be an origin without credentials.",
    );
  if (
    url.protocol === "http:" &&
    url.hostname === "localhost" &&
    environment.PLAYWRIGHT_ISOLATED_BASE_URL === url.origin
  )
    return url.origin;
  if (
    url.protocol === "https:" &&
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
  )
    return url.origin;
  throw new Error(
    "Local browser tests cannot use a shared development database. Unset PLAYWRIGHT_BASE_URL and run pnpm test:ui.",
  );
}
