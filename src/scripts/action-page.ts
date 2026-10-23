// Refresh server-rendered fragments after a successful write, without navigating
// or touching unrelated forms. The normal page still checks session and access.
export const savedRefreshError =
  "Your change was saved, but the view could not be updated. Refresh the page to see it.";

export async function loadActionPage(
  url: string = location.href,
  signal?: AbortSignal,
) {
  try {
    const response = await fetch(url, {
      credentials: "same-origin",
      cache: "no-store",
      signal,
    });
    if (response.redirected) {
      const next = new URL(response.url);
      // Changing your own role can revoke your session. That is an auth
      // navigation, not a routine action refresh.
      if (
        next.origin === location.origin &&
        next.pathname === "/volunteer/sign-in"
      )
        location.assign(next.href);
      // Portal refreshes may follow a new canonical route after completion or
      // approval changes. The event browser synchronizes its URL and navigation.
      const previous = new URL(url, location.origin);
      const portalRedirect =
        next.origin === location.origin &&
        /^\/(?:events|volunteer)\/?$/.test(previous.pathname) &&
        /^\/(?:events|volunteer)\/?$/.test(next.pathname) &&
        previous.pathname !== next.pathname;
      if (!portalRedirect) throw new Error("Unexpected redirect");
    }
    if (response.status === 401 || response.status === 403)
      location.assign("/events");
    if (!response.ok) throw new Error("Refresh failed");
    return new DOMParser().parseFromString(await response.text(), "text/html");
  } catch {
    throw new Error(savedRefreshError);
  }
}

export function actionFragment(page: Document, selector: string) {
  const fragment = page.querySelector<HTMLElement>(selector);
  if (!fragment) throw new Error(savedRefreshError);
  return document.importNode(fragment, true);
}
