import { actionFragment } from "./action-page";

let refreshBrowser: ((page: Document) => void) | undefined;
let cancelSearch = () => {};

export function cancelVolunteerSearch() {
  cancelSearch();
}

/** Refresh the queue and its global count together after organizer changes. */
export function syncVolunteerBrowser(page: Document) {
  refreshBrowser?.(page);
}

export function initVolunteerBrowser() {
  const root = document.querySelector<HTMLElement>("[data-volunteer-browser]");
  const search = root?.querySelector<HTMLInputElement>(
    "[data-volunteer-search]",
  );
  const form = root?.querySelector<HTMLFormElement>(
    "[data-volunteer-search-form]",
  );
  const results = root?.querySelector<HTMLElement>("[data-volunteer-results]");
  const filters = root?.querySelector<HTMLElement>("[data-volunteer-filters]");
  const error = root?.querySelector<HTMLElement>(
    "[data-volunteer-search-error]",
  );
  if (!search || !form || !results || !filters || !error) return;

  let timer: number | undefined;
  let pending: AbortController | undefined;
  cancelSearch = () => {
    clearTimeout(timer);
    pending?.abort();
    results.removeAttribute("aria-busy");
  };
  const replaceResults = (page: Document) => {
    // Read both before replacing either, so an expired organizer session cannot
    // leave a new count attached to stale results (or the reverse).
    const nextResults = actionFragment(page, "[data-volunteer-results]");
    const nextFilters = actionFragment(page, "[data-volunteer-filters]");
    const focused = document.activeElement;
    const focusedFilter =
      focused instanceof HTMLButtonElement && filters.contains(focused)
        ? focused.dataset.volunteerFilter
        : undefined;
    results.replaceChildren(...nextResults.childNodes);
    filters.replaceChildren(...nextFilters.childNodes);
    form.querySelector<HTMLInputElement>('[name="approval"]')!.value =
      filters.querySelector<HTMLButtonElement>('[aria-pressed="true"]')!.value;
    if (focusedFilter)
      filters
        .querySelector<HTMLButtonElement>(
          `[data-volunteer-filter="${focusedFilter}"]`,
        )
        ?.focus({ preventScroll: true });
  };
  const searchUrl = (resetOffset = true) => {
    const url = new URL(location.href);
    if (search.value) url.searchParams.set("q", search.value);
    else url.searchParams.delete("q");
    if (resetOffset) url.searchParams.delete("offset");
    return url;
  };
  const loadResults = async (
    url = searchUrl(),
    historyMode: "push" | "replace" | "none" = "replace",
  ) => {
    cancelSearch();
    const controller = new AbortController();
    pending = controller;
    results.setAttribute("aria-busy", "true");
    error.hidden = true;
    try {
      const response = await fetch(url, {
        credentials: "same-origin",
        cache: "no-store",
        signal: controller.signal,
      });
      if (!response.ok || response.redirected)
        throw new Error(
          "Could not search volunteers. Check your organizer session.",
        );
      const page = new DOMParser().parseFromString(
        await response.text(),
        "text/html",
      );
      if (!controller.signal.aborted) {
        replaceResults(page);
        if (historyMode === "push") history.pushState(null, "", url);
        else if (historyMode === "replace") history.replaceState(null, "", url);
      }
    } catch (reason) {
      if (!controller.signal.aborted) {
        error.textContent =
          reason instanceof Error
            ? reason.message
            : "Volunteer search is unavailable.";
        error.hidden = false;
      }
    } finally {
      if (!controller.signal.aborted) results.removeAttribute("aria-busy");
    }
  };
  refreshBrowser = (page) => {
    // An older search response must not put an approved application back in the
    // queue. If the organizer has since typed more, re-fetch that newer search.
    cancelSearch();
    replaceResults(page);
    error.hidden = true;
    const renderedSearch = page.querySelector<HTMLInputElement>(
      "[data-volunteer-search]",
    );
    if (renderedSearch && renderedSearch.value !== search.value)
      void loadResults();
  };
  search.addEventListener("input", () => {
    cancelSearch();
    timer = window.setTimeout(() => void loadResults(), 180);
  });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    void loadResults();
  });
  filters.addEventListener("click", (event) => {
    if (!(event.target instanceof Element)) return;
    const button = event.target.closest<HTMLButtonElement>(
      "[data-volunteer-filter]",
    );
    if (!button) return;
    event.preventDefault();
    const url = searchUrl();
    if (button.dataset.volunteerFilter === "awaiting")
      url.searchParams.set("approval", "awaiting");
    else url.searchParams.delete("approval");
    void loadResults(url, "push");
  });
  window.addEventListener("popstate", () => {
    const url = new URL(location.href);
    search.value = url.searchParams.get("q") ?? "";
    void loadResults(url, "none");
  });
  window.addEventListener("pagehide", cancelSearch);
  window.addEventListener("pageshow", (event) => {
    // Browser Back may restore the list from bfcache after a full-page approval.
    if (event.persisted) void loadResults(searchUrl(false));
  });
}
