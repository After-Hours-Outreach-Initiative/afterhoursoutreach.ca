import { actionFragment } from "./action-page";

export function initVolunteerBrowser(fetchPage: typeof fetch = fetch) {
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
  if (!root || !search || !form || !results || !error) return;
  const people = filters ? "applications" : "volunteers";

  root.dataset.rowNavigation = "true";
  results.addEventListener("click", (event) => {
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey ||
      !(event.target instanceof Element) ||
      event.target.closest(
        "a, button, input, select, textarea, label, summary, [role='button'], [contenteditable]",
      ) ||
      window.getSelection()?.toString()
    )
      return;
    const row = event.target.closest("[data-volunteer-row]");
    const link = row?.querySelector<HTMLAnchorElement>(
      "[data-volunteer-profile-link]",
    );
    if (link) location.assign(link.href);
  });

  let timer: number | undefined;
  let pending: AbortController | undefined;
  const cancelSearch = () => {
    clearTimeout(timer);
    pending?.abort();
    results.removeAttribute("aria-busy");
  };
  const replaceResults = (page: Document) => {
    // Read both before replacing either, so an expired organizer session cannot
    // leave a new count attached to stale results (or the reverse).
    const nextResults = actionFragment(page, "[data-volunteer-results]");
    const nextFilters = filters
      ? actionFragment(page, "[data-volunteer-filters]")
      : undefined;
    const focused = document.activeElement;
    const focusedFilter =
      focused instanceof HTMLButtonElement && filters?.contains(focused)
        ? focused.dataset.volunteerFilter
        : undefined;
    const focusedSort =
      focused instanceof HTMLAnchorElement && results.contains(focused)
        ? focused.dataset.volunteerSort
        : undefined;
    results.replaceChildren(...nextResults.childNodes);
    if (filters && nextFilters) {
      filters.replaceChildren(...nextFilters.childNodes);
      form.querySelector<HTMLInputElement>('[name="approval"]')!.value =
        filters.querySelector<HTMLButtonElement>(
          '[aria-pressed="true"]',
        )!.value;
    }
    if (focusedFilter)
      filters
        ?.querySelector<HTMLButtonElement>(
          `[data-volunteer-filter="${focusedFilter}"]`,
        )
        ?.focus({ preventScroll: true });
    for (const name of ["sort", "direction"]) {
      const input = form.querySelector<HTMLInputElement>(`[name="${name}"]`);
      const nextInput = page.querySelector<HTMLInputElement>(
        `[data-volunteer-search-form] [name="${name}"]`,
      );
      if (input && nextInput) input.value = nextInput.value;
    }
    if (focusedSort)
      results
        .querySelector<HTMLAnchorElement>(
          `[data-volunteer-sort="${focusedSort}"]`,
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
      const response = await fetchPage(url, {
        credentials: "same-origin",
        cache: "no-store",
        signal: controller.signal,
      });
      if (!response.ok || response.redirected)
        throw new Error(
          `Could not search ${people}. Check your organizer session.`,
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
            : `Could not search ${people}. Please try again.`;
        error.hidden = false;
      }
    } finally {
      if (!controller.signal.aborted) results.removeAttribute("aria-busy");
    }
  };
  search.addEventListener("input", () => {
    cancelSearch();
    timer = window.setTimeout(() => void loadResults(), 180);
  });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    void loadResults();
  });
  results.addEventListener("click", (event) => {
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey ||
      !(event.target instanceof Element)
    )
      return;
    const link = event.target.closest<HTMLAnchorElement>(
      "[data-volunteer-sort]",
    );
    if (!link) return;
    event.preventDefault();
    const url = searchUrl();
    const target = new URL(link.href);
    for (const name of ["sort", "direction"]) {
      const value = target.searchParams.get(name);
      if (value) url.searchParams.set(name, value);
      else url.searchParams.delete(name);
    }
    void loadResults(url, "push");
  });
  filters?.addEventListener("click", (event) => {
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
