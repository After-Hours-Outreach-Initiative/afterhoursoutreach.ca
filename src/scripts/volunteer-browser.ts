import { actionFragment, syncHeaderApplications } from "./action-page";
import { initDirectoryTableHeader } from "./directory-table-header";
import { initFilterMenus } from "./filter-menu";
import { initRoleOrder } from "./role-order";
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
    for (const key of [
      "q",
      "approval",
      "role",
      "order",
      "sort",
      "direction",
      "offset",
    ])
      url.searchParams.delete(key);
    new URL(directoryListUrl(kind, state), url).searchParams.forEach(
      (value, key) => url.searchParams.append(key, value),
    );
    return url;
  };
  // The menus' controls are the pending state until they are applied.
  const stateFromForm = () => {
    const params = new URLSearchParams();
    for (const [name, value] of new FormData(form))
      params.append(name, String(value));
    params.set("q", search.value.slice(0, 100));
    return directoryListState(params, kind);
  };
  const sortMenu = form.querySelector<HTMLElement>('[data-filter-menu="sort"]');
  const showRoleOrder = sortMenu ? initRoleOrder(sortMenu) : () => {};
  const sortLabels = new Map(
    [...form.querySelectorAll<HTMLInputElement>('input[name="sort"]')].map(
      (input) => [input.value, input.closest("label")!.textContent!.trim()],
    ),
  );
  const syncControls = (state: DirectoryListState) => {
    const values: Record<string, readonly string[]> = {
      approval: state.approval,
      role: state.roles,
    };
    for (const menu of form.querySelectorAll<HTMLElement>(
      "[data-filter-menu]",
    )) {
      // Never discard choices in a menu that is still open.
      if (menu.matches(":popover-open")) continue;
      const name = menu.dataset.filterMenu!;
      if (name === "sort") {
        for (const input of menu.querySelectorAll<HTMLInputElement>(
          'input[type="radio"]',
        ))
          input.checked =
            input.value ===
            (input.name === "sort" ? state.sort : state.direction);
        showRoleOrder(state.roleOrder, state.sort);
        continue;
      }
      for (const input of menu.querySelectorAll<HTMLInputElement>(
        'input[type="checkbox"]',
      ))
        input.checked = values[name]?.includes(input.value) ?? false;
    }
    for (const trigger of form.querySelectorAll<HTMLElement>(
      "[data-filter-trigger]",
    )) {
      const selected = values[trigger.dataset.filterTrigger!]?.length ?? 0;
      trigger.toggleAttribute("data-active", selected > 0);
      const badge = trigger.querySelector<HTMLElement>(
        "[data-filter-selected]",
      )!;
      badge.hidden = !selected;
      badge.firstChild!.textContent = String(selected);
    }
    const label = form.querySelector<HTMLElement>("[data-sort-label]");
    if (label) label.textContent = sortLabels.get(state.sort) ?? state.sort;
    const reset = form.querySelector<HTMLAnchorElement>(
      "[data-directory-reset]",
    );
    if (reset) {
      reset.hidden = !state.approval.length && !state.roles.length;
      reset.href = urlFor({ ...state, approval: [], roles: [] }).href;
    }
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
    const counts: Record<string, Record<string, number>> = {
      approval: {
        awaiting: view.awaitingApprovalCount,
        "in-progress": view.inProgressCount,
        rejected: view.rejectedCount,
        approved: view.approvedCount,
      },
      role: view.roleCounts,
    };
    form
      .querySelectorAll<HTMLElement>("[data-filter-count]")
      .forEach((element) => {
        const menu = element.closest<HTMLElement>("[data-filter-menu]")!;
        element.textContent = String(
          counts[menu.dataset.filterMenu!]?.[element.dataset.filterCount!] ?? 0,
        );
      });
    syncControls(state);
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
    if (historyMode === "push" && url.href !== location.href)
      history.pushState(null, "", url);
    else if (historyMode !== "none") history.replaceState(null, "", url);
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
      syncHeaderApplications(page);
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
  // Closing a menu applies its choices, as its Apply button does.
  initFilterMenus(form, () => render(stateFromForm(), "push"));
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const open = form.querySelector<HTMLElement>(
      "[data-filter-menu]:popover-open",
    );
    if (open) open.hidePopover();
    else render(stateFromForm(), "push");
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
  form.addEventListener("click", (event) => {
    if (
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey ||
      !(event.target instanceof Element) ||
      !event.target.closest("[data-directory-reset]")
    )
      return;
    event.preventDefault();
    render({ ...stateFor(), approval: [], roles: [] }, "push");
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
