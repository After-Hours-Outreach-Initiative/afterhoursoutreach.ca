import { actionFragment, syncHeaderApplications } from "./action-page";
import { initFilterMenus } from "./filter-menu";
import { initFilterPanel } from "./filter-panel";
import { initPressFeedback } from "./press-feedback";
import { initSortOrders } from "./sort-order";
import {
  directoryCountLabel,
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
    ...root.querySelectorAll<HTMLElement>("[data-volunteer-row]"),
    ...(template?.content.querySelectorAll<HTMLElement>(
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
  const list = results?.querySelector<HTMLElement>("[data-volunteer-list]");
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
    !list ||
    !count
  )
    return;
  const kind = root.dataset.directoryKind as DirectoryKind;
  let rows = readRows(root);
  let pending: AbortController | undefined;
  // Nothing searched, filtered or re-sorted.
  const defaultState = directoryListState(new URLSearchParams(), kind);
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
      "statusOrder",
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
  const sortSection = form.querySelector<HTMLElement>("[data-directory-sort]");
  const showSortOrders = sortSection ? initSortOrders(sortSection) : () => {};
  // Choices apply as they change beside the list, or when the sheet closes.
  const panel = initFilterPanel(form, () => render(stateFromForm(), "push"));
  const sortMenu = form.querySelector<HTMLElement>('[data-filter-menu="sort"]');
  const sortLabels = new Map(
    [...form.querySelectorAll<HTMLInputElement>('input[name="sort"]')].map(
      (input) => [input.value, input.closest("label")!.textContent!.trim()],
    ),
  );
  if (sortMenu) initFilterMenus(sortMenu.parentElement!, () => {});
  sortMenu?.addEventListener("click", (event) => {
    if (
      !(event.target instanceof Element) ||
      !event.target.closest("[data-sort-reset]") ||
      !sortSection
    )
      return;
    for (const input of sortSection.querySelectorAll<HTMLInputElement>(
      'input[type="radio"]',
    ))
      input.checked =
        input.value ===
        (input.name === "sort" ? sortSection.dataset.sortDefault : "asc");
    // The reset button hides, so keep focus on the chosen sort.
    sortSection
      .querySelector<HTMLInputElement>('input[name="sort"]:checked')
      ?.focus();
    render(stateFromForm(), "push");
  });
  // The sort menu applies each change, as the filter sidebar does.
  sortMenu?.addEventListener("change", (event) => {
    if (
      event.target instanceof HTMLInputElement &&
      event.target.closest("[data-directory-sort]")
    )
      render(stateFromForm(), "push");
  });
  const syncControls = (state: DirectoryListState) => {
    // Never discard choices in a sheet that is still open.
    if (panel.isOpen()) return;
    const values: Record<string, readonly string[]> = {
      approval: state.approval,
      role: state.roles,
    };
    for (const input of form.querySelectorAll<HTMLInputElement>(
      'input[type="checkbox"]',
    ))
      input.checked = values[input.name]?.includes(input.value) ?? false;
    for (const input of form.querySelectorAll<HTMLInputElement>(
      'input[type="radio"]',
    ))
      input.checked =
        input.value === (input.name === "sort" ? state.sort : state.direction);
    showSortOrders(
      { order: state.roleOrder, statusOrder: state.statusOrder },
      state.sort,
    );
    panel.update();
    // Offer to restore the default sort only once it has changed.
    const sortReset = form.querySelector<HTMLElement>("[data-sort-reset]");
    if (sortReset && sortSection)
      sortReset.hidden =
        state.sort === sortSection.dataset.sortDefault &&
        state.direction === "asc";
    const label = form.querySelector<HTMLElement>("[data-sort-label]");
    if (label) label.textContent = sortLabels.get(state.sort) ?? state.sort;
    const reset = form.querySelector<HTMLAnchorElement>("[data-filter-reset]");
    if (reset) reset.href = urlFor({ ...state, approval: [], roles: [] }).href;
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
        const section = element.closest<HTMLElement>("[data-filter-section]")!;
        element.textContent = String(
          counts[section.dataset.filterSection!]?.[
            element.dataset.filterCount!
          ] ?? 0,
        );
      });
    syncControls(state);
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
    list.replaceChildren(...view.rows.map(({ id }) => rows.get(id)!.node));
    empty.querySelector("[data-volunteer-empty-message]")!.textContent =
      directoryEmptyMessage(kind, state);
    const resetAll = empty.querySelector<HTMLAnchorElement>(
      "[data-directory-reset-all]",
    );
    if (resetAll) {
      const defaultUrl = urlFor(defaultState).href;
      resetAll.href = defaultUrl;
      resetAll.hidden = url.href === defaultUrl;
    }
    empty.hidden = Boolean(view.rows.length);
    list.hidden = !view.rows.length;
    count.textContent = directoryCountLabel(kind, view.rows.length, rows.size);
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
          ? focused.closest<HTMLElement>("[data-volunteer-row]")?.dataset
              .directoryPerson
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
    render(stateFromForm(), "push");
  });
  initPressFeedback(results, "[data-volunteer-row]");
  // The empty result's reset returns everything to the defaults in place.
  empty.addEventListener("click", (event) => {
    if (
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey ||
      !(event.target instanceof Element) ||
      !event.target.closest("[data-directory-reset-all]")
    )
      return;
    event.preventDefault();
    render(defaultState, "push");
    search.focus();
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
