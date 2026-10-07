// Refresh server-rendered fragments after a successful write, without navigating
// or touching unrelated forms. The normal page still checks session and access.
export const savedRefreshError =
  "Your change was saved, but the view could not be updated. Refresh the page to see it.";

export async function loadActionPage(url: string = location.href) {
  try {
    const response = await fetch(url, {
      credentials: "same-origin",
      cache: "no-store",
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
      throw new Error("Unexpected redirect");
    }
    if (response.status === 401 || response.status === 403)
      location.assign("/volunteer");
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
