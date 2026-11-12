import type { TransitionBeforePreparationEvent } from "astro:transitions/client";

interface PageHistoryState extends Record<string, unknown> {
  index?: number;
  scrollX?: number;
  scrollY?: number;
  appLocalRoute?: string;
}

function state(): PageHistoryState {
  return history.state && typeof history.state === "object"
    ? history.state
    : {};
}

function routeKey(url: URL, entry: PageHistoryState) {
  return document.querySelector('[name="astro-view-transitions-enabled"]') &&
    typeof entry.index === "number"
    ? `${entry.index}:${url.pathname}`
    : undefined;
}

let activeRoute = routeKey(new URL(location.href), state());
let pendingNavigation: AbortSignal | undefined;
document.addEventListener("astro:before-preparation", (event) => {
  const { signal } = event as TransitionBeforePreparationEvent;
  pendingNavigation = signal;
  signal.addEventListener(
    "abort",
    () => {
      if (pendingNavigation === signal) pendingNavigation = undefined;
    },
    { once: true },
  );
});
document.addEventListener("astro:page-load", () => {
  pendingNavigation = undefined;
});
const syncRoute = () => {
  activeRoute = routeKey(new URL(location.href), state());
};
document.addEventListener("astro:after-swap", syncRoute);
document.addEventListener("astro:page-load", syncRoute);

/** Local filters and calendar anchors share the route's Astro index. They
 * preserve its metadata and save a separate scroll position for each entry. */
export function updateLocalUrl(url: URL | string, mode: "push" | "replace") {
  const next = new URL(url, location.href);
  const entry = { ...state(), scrollX, scrollY };
  const group = routeKey(next, entry);
  if (group) entry.appLocalRoute = group;
  if (mode === "push") {
    // Save the position of the entry we are leaving before creating the next.
    history.replaceState(entry, "");
    history.pushState(entry, "", next);
  } else history.replaceState(entry, "", next);
  activeRoute = group;
}

// Handle only local entries in the currently mounted route. Cross-page history
// belongs to Astro; letting both handlers run would repaint the outgoing list
// while the router is restoring a different page. Capture precedes its handler.
window.addEventListener(
  "popstate",
  (event) => {
    const entry = state();
    if (
      // Let Astro cancel an in-flight page load before restoring this entry.
      pendingNavigation ||
      !activeRoute ||
      entry.appLocalRoute !== activeRoute ||
      routeKey(new URL(location.href), entry) !== activeRoute
    )
      return;
    event.stopImmediatePropagation();
    window.dispatchEvent(new Event("app:local-history"));
    scrollTo({
      left: typeof entry.scrollX === "number" ? entry.scrollX : 0,
      top: typeof entry.scrollY === "number" ? entry.scrollY : 0,
      behavior: "instant",
    });
  },
  { capture: true },
);
