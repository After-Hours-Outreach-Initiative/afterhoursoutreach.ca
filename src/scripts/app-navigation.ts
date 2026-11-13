import type { TransitionBeforePreparationEvent } from "astro:transitions/client";
import { scrollToPageTop } from "./scroll-to-top";
import { appRoutes, isAppRoute } from "../data/app-routes";

// Private HTML stays out of HTTP/shared caches and persistent browser storage.
// This small cache lives only in this document's signed-in navigation session.
const ttl = 10_000;
const maxBytes = 2_000_000;
interface Screen {
  html: string;
  expires: number;
  scope: string;
}
const screens = new Map<string, Screen>();
const scrolls = new Map<string, { left: number; top: number }>();
const warming = new Map<string, AbortController>();
const assets = new Set<string>();
// Destination stylesheets settle once, whether preloaded early or on a tap.
const styles = new Map<string, Promise<void>>();
let generation = 0;
let activeNavigation: TransitionBeforePreparationEvent | undefined;
let warmingTimer: ReturnType<typeof setTimeout> | undefined;
// The router state of the entry a native fragment link is leaving.
let fragmentFrom: { index?: unknown } | null = null;
const scope = () => document.body.dataset.appScope;
const key = (url: URL) => url.origin + url.pathname + url.search;
const tabKey = (url: URL) => url.origin + url.pathname;
const eligible = (url: URL) =>
  url.origin === location.origin && appRoutes.has(url.pathname) && !url.search;

// Warming resumes on the next screen load or return to the tab, not after
// every interaction, so edits never trigger repeated full page renders.
function clearScreens() {
  generation++;
  screens.clear();
  for (const controller of warming.values()) controller.abort();
  warming.clear();
  clearTimeout(warmingTimer);
}
function preloadStyle(href: string) {
  let loaded = styles.get(href);
  if (!loaded) {
    loaded = new Promise<void>((resolve) => {
      const preload = document.createElement("link");
      preload.rel = "preload";
      preload.as = "style";
      preload.href = href;
      preload.onload = preload.onerror = () => resolve();
      document.head.appendChild(preload);
    });
    styles.set(href, loaded);
  }
  return loaded;
}
function remember(url: URL, html: string) {
  const owner = scope();
  if (!owner || !eligible(url) || html.length * 2 > maxBytes) return;
  const page = new DOMParser().parseFromString(html, "text/html");
  if (
    page.body.dataset.appScope !== owner ||
    !page.querySelector('[name="astro-view-transitions-enabled"]')
  )
    return;
  // Fetch immutable destination assets ahead of the tap without executing its
  // scripts. Otherwise a cached HTML response can still wait on a JS round trip.
  for (const element of page.querySelectorAll<
    HTMLLinkElement | HTMLScriptElement
  >('link[rel="stylesheet"], script[type="module"][src]')) {
    const href =
      element instanceof HTMLLinkElement ? element.href : element.src;
    const asset = new URL(href, location.href);
    if (
      asset.origin !== location.origin ||
      !asset.pathname.startsWith("/_astro/") ||
      assets.has(asset.href) ||
      assets.size >= 32
    )
      continue;
    assets.add(asset.href);
    if (element instanceof HTMLLinkElement) {
      void preloadStyle(asset.href);
      continue;
    }
    const preload = document.createElement("link");
    preload.rel = "modulepreload";
    preload.href = asset.href;
    document.head.appendChild(preload);
  }
  screens.delete(key(url));
  screens.set(key(url), { html, expires: Date.now() + ttl, scope: owner });
  while (
    [...screens.values()].reduce(
      (sum, screen) => sum + screen.html.length * 2,
      0,
    ) > maxBytes
  )
    screens.delete(screens.keys().next().value!);
}
function cached(url: URL) {
  const screen = screens.get(key(url));
  if (!screen || screen.expires <= Date.now() || screen.scope !== scope()) {
    screens.delete(key(url));
    return;
  }
  return new DOMParser().parseFromString(screen.html, "text/html");
}
async function warm(url: URL) {
  if (
    !scope() ||
    !eligible(url) ||
    key(url) === key(new URL(location.href)) ||
    cached(url) ||
    warming.has(key(url)) ||
    document.hidden
  )
    return;
  const connection = (
    navigator as Navigator & {
      connection?: { saveData?: boolean; effectiveType?: string };
    }
  ).connection;
  if (
    connection?.saveData ||
    ["slow-2g", "2g"].includes(connection?.effectiveType ?? "")
  )
    return;
  const controller = new AbortController();
  const epoch = generation;
  warming.set(key(url), controller);
  try {
    const response = await fetch(url, {
      credentials: "same-origin",
      cache: "no-store",
      signal: controller.signal,
    });
    if (
      !response.ok ||
      response.redirected ||
      !response.headers.get("content-type")?.includes("text/html")
    )
      return;
    const html = await response.text();
    if (generation === epoch && !controller.signal.aborted) remember(url, html);
  } catch {
    /* Navigation still uses the normal authenticated server path. */
  } finally {
    if (warming.get(key(url)) === controller) warming.delete(key(url));
  }
}
function warmDock() {
  clearTimeout(warmingTimer);
  warmingTimer = setTimeout(async () => {
    for (const link of document.querySelectorAll<HTMLAnchorElement>(
      ".app-dock a",
    )) {
      const epoch = generation;
      await warm(new URL(link.href));
      if (epoch !== generation) break;
    }
  }, 1_000);
}
function resetFeedback() {
  document.querySelector(".app-dock")?.removeAttribute("aria-busy");
  for (const item of document.querySelectorAll("[data-loading]"))
    item.removeAttribute("data-loading");
}

// Save original server markup, never a DOM snapshot of edited forms or dialogs.
document.addEventListener("astro:before-preparation", (event) => {
  const navigation = event as TransitionBeforePreparationEvent;
  resetFeedback();
  activeNavigation = navigation;
  const currentTab = document.querySelector<HTMLAnchorElement>(
    '.app-dock a[aria-current="page"]',
  );
  // Tab memory is independent of history entries. Native Back/Forward already
  // restores its own entry's position and must never be overridden by this map.
  if (navigation.navigationType !== "traverse")
    scrolls.set(
      tabKey(currentTab ? new URL(currentTab.href) : navigation.from),
      { left: scrollX, top: scrollY },
    );
  if (scrolls.size > 16) scrolls.delete(scrolls.keys().next().value!);
  const link = navigation.sourceElement?.closest(".app-dock a");
  link?.setAttribute("data-loading", "");
  document.querySelector(".app-dock")?.setAttribute("aria-busy", "true");
  const loader = navigation.loader;
  const epoch = generation;
  navigation.loader = async () => {
    try {
      const hit =
        !navigation.formData && eligible(navigation.to)
          ? cached(navigation.to)
          : undefined;
      if (hit) {
        navigation.newDocument = hit;
        // Load destination styles before Astro paints its cached document.
        await Promise.all(
          [
            ...hit.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]'),
          ].map((style) =>
            [
              ...document.querySelectorAll<HTMLLinkElement>(
                'link[rel="stylesheet"]',
              ),
            ].some((existing) => existing.href === style.href)
              ? undefined
              : preloadStyle(style.href),
          ),
        );
      } else {
        await loader();
        if (
          generation === epoch &&
          !navigation.signal.aborted &&
          navigation.newDocument !== document
        )
          remember(
            navigation.to,
            navigation.newDocument.documentElement.outerHTML,
          );
      }
    } finally {
      if (navigation.signal.aborted && activeNavigation === navigation)
        resetFeedback();
    }
  };
});

document.addEventListener("astro:before-swap", (event) => {
  const next = (
    event as import("astro:transitions/client").TransitionBeforeSwapEvent
  ).newDocument;
  if (next.body.dataset.appScope !== scope()) clearScreens();
  // Do not expose controls until their screen scripts have initialized.
  const main = next.getElementById("main-content");
  if (main) main.inert = true;
});

document.addEventListener("astro:page-load", () => {
  resetFeedback();
  const main = document.getElementById("main-content");
  if (main) main.inert = false;
  const dockNavigation =
    activeNavigation?.navigationType === "push" &&
    activeNavigation.sourceElement?.closest(".app-dock a");
  const saved = dockNavigation
    ? scrolls.get(tabKey(new URL(location.href)))
    : undefined;
  if (saved && !location.hash) scrollTo({ ...saved, behavior: "instant" });
  activeNavigation = undefined;
  warmDock();
});
// Existing forms own their API submission and review-step validation. Keep
// ClientRouter from submitting them before their delegated handlers run.
document.addEventListener(
  "submit",
  (event) => {
    if (event.target instanceof HTMLFormElement)
      event.target.setAttribute("data-astro-reload", "");
  },
  { capture: true },
);

// Mutations and leaving the browser invalidate speculative private content.
for (const type of [
  "app-data-changed",
  "submit",
  "pending-action-added",
  "pending-action-resolved",
  "account-content-updated",
])
  document.addEventListener(type, clearScreens, { capture: true });
document.addEventListener(
  "click",
  (event) => {
    // Routes outside the dock use document navigation directly. Otherwise the
    // router fetches once to discover its fallback, then loads it again; detail
    // pages deliberately audit each read and must not be visited twice.
    const link =
      event.target instanceof Element
        ? event.target.closest<HTMLAnchorElement>("a[href]")
        : null;
    if (
      !event.defaultPrevented &&
      event.button === 0 &&
      !event.metaKey &&
      !event.ctrlKey &&
      !event.shiftKey &&
      !event.altKey &&
      link?.matches('.app-dock a[aria-current="page"]') &&
      link.origin === location.origin &&
      link.pathname.replace(/\/$/, "") === location.pathname.replace(/\/$/, "")
    ) {
      event.preventDefault();
      scrollToPageTop();
      return;
    }
    if (link) {
      const target = new URL(link.href);
      // Same-page fragments stay native, so the browser owns their scrolling,
      // focus and history instead of the router.
      const fragment =
        target.hash &&
        target.origin === location.origin &&
        target.pathname === location.pathname &&
        target.search === location.search;
      if (fragment) fragmentFrom = history.state;
      if (
        fragment ||
        (scope() &&
          target.origin === location.origin &&
          !isAppRoute(target.pathname))
      )
        link.setAttribute("data-astro-reload", "");
    }
    if (
      event.target instanceof Element &&
      event.target.closest("[data-switch-user]")
    )
      clearScreens();
  },
  { capture: true },
);
// A native fragment entry has no router state, so a reload would open at the
// top. Index it between its neighbours: Back and Forward then scroll within the
// page, and the router keeps its saved position for reloads.
window.addEventListener("hashchange", () => {
  const from = fragmentFrom;
  fragmentFrom = null;
  if (history.state !== null || typeof from?.index !== "number") return;
  const next = Math.floor(from.index) + 1;
  history.replaceState(
    { index: from.index + (next - from.index) / 2, scrollX, scrollY },
    "",
  );
});
document.addEventListener("visibilitychange", () => {
  if (document.hidden) clearScreens();
  else warmDock();
});
window.addEventListener("pagehide", clearScreens);
// Another window may have signed out or changed data.
window.addEventListener("focus", clearScreens);
window.addEventListener("storage", clearScreens);
window.addEventListener("pageshow", resetFeedback);
// Record actual tap-to-screen time, available in browser Performance entries.
document.addEventListener("astro:before-preparation", () =>
  performance.mark("app-navigation-start"),
);
document.addEventListener("astro:page-load", () => {
  if (performance.getEntriesByName("app-navigation-start").length) {
    performance.measure("app-navigation", "app-navigation-start");
    performance.clearMarks("app-navigation-start");
  }
});
