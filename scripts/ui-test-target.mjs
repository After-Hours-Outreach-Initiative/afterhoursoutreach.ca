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

/**
 * The separate server for `@serial` tests, which must not see data or load
 * from the parallel run. Without one, as in benchmarks, they use the main target.
 * @param {Record<string, string | undefined>} [environment]
 */
export function serialTarget(environment = process.env) {
  const main = playwrightTarget(environment);
  const value = environment.PLAYWRIGHT_SERIAL_BASE_URL;
  if (!value) return main;
  const url = new URL(value);
  if (
    url.protocol !== "http:" ||
    url.hostname !== "localhost" ||
    url.origin !== value.replace(/\/$/, "") ||
    url.origin === main ||
    !main.startsWith("http://localhost:")
  )
    throw new Error(
      "PLAYWRIGHT_SERIAL_BASE_URL must be a separate managed local origin. Run pnpm test:ui.",
    );
  return url.origin;
}
