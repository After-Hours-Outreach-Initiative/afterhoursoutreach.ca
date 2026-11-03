import { actionFragment } from "./action-page";
import { initDirectoryTableHeader } from "./directory-table-header";
import {
  directoryEmptyMessage,
  directoryListState,
  directoryListUrl,
  directoryView,
  type DirectoryKind,
  type DirectoryListState,
  type DirectoryPerson,
} from "../data/volunteer-list";

/** Rows and their small search index live only in this page's memory. */
function readRows(root: HTMLElement) {
  const template = root.querySelector<HTMLTemplateElement>(
    "[data-volunteer-cached-rows]",
  );
  const nodes = [
    ...root.querySelectorAll<HTMLTableRowElement>("[data-volunteer-row]"),
    ...(template?.content.querySelectorAll<HTMLTableRowElement>(
      "[data-volunteer-row]",
    ) ?? []),
  ];
  const rows = new Map(
    nodes.map((node) => {
      const person: DirectoryPerson = JSON.parse(node.dataset.directoryPerson!);
      return [person.id, { person, node }] as const;
    }),
  );
  template?.remove();
  return rows;
}

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
  const empty = root?.querySelector<HTMLElement>("[data-volunteer-empty]");
  const tbody = results?.querySelector("tbody");
  const count = root?.querySelector<HTMLElement>(
    "[data-volunteer-result-count]",
  );
  if (
    !root ||
    !search ||
    !form ||
    !results ||
    !error ||
    !empty ||
    !tbody ||
    !count
  )
    return;
  const kind = root.dataset.directoryKind as DirectoryKind;
  const refreshTableHeader = initDirectoryTableHeader(results);
  let rows = readRows(root);
  let pending: AbortController | undefined;
  const stateFor = (url = new URL(location.href)) =>
    directoryListState(url.searchParams, kind);

  // Preserve development fixture options while normalizing directory state and
  // dropping obsolete pagination from bookmarked and profile-return URLs.
  const urlFor = (state: DirectoryListState) => {
    const url = new URL(location.href);
    for (const key of ["q", "approval", "sort", "direction", "offset"])
      url.searchParams.delete(key);
    new URL(directoryListUrl(kind, state), url).searchParams.forEach(
      (value, key) => url.searchParams.set(key, value),
    );
    return url;
  };

  const render = (
    state: DirectoryListState,
    historyMode: "push" | "replace" | "none" = "replace",
  ) => {
    const view = directoryView(
      [...rows.values()].map(({ person }) => person),
      kind,
      state,
    );
    const url = urlFor(state);
    search.value = state.search;
    for (const [name, value] of Object.entries({
      q: state.search,
      approval: state.approval,
      sort: state.sort,
      direction: state.direction,
    })) {
      root
        .querySelectorAll<HTMLInputElement>(
          `input[type="hidden"][name="${name}"]`,
        )
        .forEach((input) => {
          input.value = value;
        });
    }
    const counts: Record<string, number> = {
      all: view.allApplicantsCount,
      awaiting: view.awaitingApprovalCount,
      "in-progress": view.inProgressCount,
      rejected: view.rejectedCount,
      approved: view.approvedCount,
    };
    filters
      ?.querySelectorAll<HTMLElement>("[data-volunteer-count]")
      .forEach((element) => {
        element.textContent = String(counts[element.dataset.volunteerCount!]);
      });
    filters
      ?.querySelectorAll<HTMLButtonElement>("[data-volunteer-filter]")
      .forEach((button) => {
        button.setAttribute(
          "aria-pressed",
          String(button.value === state.approval),
        );
      });
    results
      .querySelectorAll<HTMLElement>("[data-directory-column]")
      .forEach((column) => {
        if (column.dataset.directoryColumn === state.sort)
          column.setAttribute(
            "aria-sort",
            state.direction === "asc" ? "ascending" : "descending",
          );
        else column.removeAttribute("aria-sort");
      });
    results
      .querySelectorAll<HTMLAnchorElement>("[data-volunteer-sort]")
      .forEach((link) => {
        const sort = link.dataset.volunteerSort as DirectoryListState["sort"];
        const direction =
          state.sort === sort && state.direction === "asc" ? "desc" : "asc";
        link.href = urlFor({ ...state, sort, direction }).href;
        link.setAttribute(
          "aria-label",
          `${link.textContent!.trim()}: sort ${direction === "asc" ? "ascending" : "descending"}`,
        );
      });
    for (const { node } of rows.values()) {
      const link = node.querySelector<HTMLAnchorElement>(
        "[data-volunteer-profile-link]",
      );
      if (!link) continue;
      const profileUrl = new URL(link.getAttribute("href")!, location.href);
      if (profileUrl.searchParams.has("returnTo")) {
        profileUrl.searchParams.set("returnTo", url.pathname + url.search);
        link.setAttribute("href", profileUrl.pathname + profileUrl.search);
      }
    }
    tbody.replaceChildren(...view.rows.map(({ id }) => rows.get(id)!.node));
    empty.textContent = directoryEmptyMessage(kind, state);
    empty.hidden = Boolean(view.rows.length);
    count.textContent = `${view.rows.length} ${kind === "applications" ? (view.rows.length === 1 ? "application" : "applications") : view.rows.length === 1 ? "volunteer" : "volunteers"}`;
    refreshTableHeader();
    if (historyMode === "push") history.pushState(null, "", url);
    else if (historyMode === "replace") history.replaceState(null, "", url);
  };

  // A refresh never owns the search state: typing, sorting and filtering remain
  // instant while it runs, and its eventual rows use the latest local state.
  const refresh = async () => {
    if (pending || document.hidden) return;
    const controller = new AbortController();
    pending = controller;
    results.setAttribute("aria-busy", "true");
    error.hidden = true;
    try {
      const response = await fetchPage(urlFor(stateFor()), {
        credentials: "same-origin",
        cache: "no-store",
        signal: controller.signal,
      });
      if (!response.ok || response.redirected)
        throw new Error(`Could not refresh ${kind}. Please reload the page.`);
      const page = new DOMParser().parseFromString(
        await response.text(),
        "text/html",
      );
      const nextRoot = actionFragment(page, "[data-volunteer-browser]");
      if (nextRoot.dataset.directoryKind !== kind)
        throw new Error(`Could not refresh ${kind}. Please reload the page.`);
      if (controller.signal.aborted) return;
      const focused = document.activeElement;
      const focusedId =
        focused instanceof Element
          ? focused.closest<HTMLTableRowElement>("[data-volunteer-row]")
              ?.dataset.directoryPerson
          : undefined;
      rows = readRows(nextRoot);
      render(stateFor(), "none");
      if (focusedId)
        rows
          .get((JSON.parse(focusedId) as DirectoryPerson).id)
          ?.node.querySelector<HTMLAnchorElement>(
            "[data-volunteer-profile-link]",
          )
          ?.focus({ preventScroll: true });
    } catch (reason) {
      if (!controller.signal.aborted) {
        error.textContent =
          reason instanceof Error
            ? reason.message
            : `Could not refresh ${kind}. Please reload the page.`;
        error.hidden = false;
      }
    } finally {
      if (pending === controller) {
        pending = undefined;
        results.removeAttribute("aria-busy");
      }
    }
  };

  search.addEventListener("input", () =>
    render({ ...stateFor(), search: search.value.slice(0, 100) }),
  );
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    render({ ...stateFor(), search: search.value.slice(0, 100) });
  });
  const submit = form.querySelector<HTMLButtonElement>(
    "[data-volunteer-search-submit]",
  );
  if (submit) submit.hidden = true;
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
    render(stateFor(new URL(link.href)), "push");
  });
  filters?.addEventListener("click", (event) => {
    if (!(event.target instanceof Element)) return;
    const button = event.target.closest<HTMLButtonElement>(
      "[data-volunteer-filter]",
    );
    if (!button) return;
    event.preventDefault();
    const url = urlFor(stateFor());
    url.searchParams.set("approval", button.value);
    render(stateFor(url), "push");
  });
  window.addEventListener("popstate", () => render(stateFor(), "none"));
  window.addEventListener("focus", () => void refresh());
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) void refresh();
  });
  window.addEventListener("pagehide", () => {
    pending?.abort();
    pending = undefined;
    results.removeAttribute("aria-busy");
  });
  window.addEventListener("pageshow", (event) => {
    if (event.persisted) void refresh();
  });
  render(stateFor());
}
