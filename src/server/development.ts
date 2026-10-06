/** Development controls also support phones accessing the dev server over LAN. */
export function isLocalDevelopment(request: Request | undefined) {
  return Boolean(import.meta.env?.DEV && request);
}
