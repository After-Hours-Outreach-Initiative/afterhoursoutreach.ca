/** Development controls also support phones accessing the dev server over LAN. */
export function isLocalDevelopment(
  bindings: Pick<Env, "APP_ENV" | "AUTH_BASE_URL">,
  request: Request | undefined,
) {
  return Boolean(
    import.meta.env?.DEV && bindings.APP_ENV === "local" && request,
  );
}
