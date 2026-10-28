import { initPageContents } from "./page-contents";

const disposers = new WeakMap<HTMLElement, () => void>();

export function disposeVolunteerProfileTabs(root: HTMLElement) {
  for (const list of root.querySelectorAll<HTMLElement>(
    "[data-volunteer-profile-tabs]",
  )) {
    disposers.get(list)?.();
    disposers.delete(list);
  }
}

/** Enhance ordinary section links; both sections remain readable without JS. */
export function initVolunteerProfileTabs(
  root: Document | HTMLElement = document,
  selected?: string,
) {
  for (const list of root.querySelectorAll<HTMLElement>(
    "[data-volunteer-profile-tabs]:not([data-tabs-ready])",
  )) {
    const flow = list.closest<HTMLElement>("[data-volunteer-profile]");
    if (!flow) continue;
    const tabs = [
      ...list.querySelectorAll<HTMLAnchorElement>(
        "[data-volunteer-profile-tab]",
      ),
    ];
    const panels = tabs.map((tab) => flow.querySelector<HTMLElement>(tab.hash));
    if (!tabs.length || panels.some((panel) => !panel)) continue;

    const activate = (index: number, focus = false) => {
      tabs.forEach((tab, position) => {
        const active = position === index;
        tab.setAttribute("aria-selected", String(active));
        tab.tabIndex = active ? 0 : -1;
        panels[position]!.hidden = !active;
      });
      if (focus) tabs[index]!.focus({ preventScroll: true });
    };
    const revealTarget = (target: HTMLElement) => {
      const index = panels.findIndex((panel) => panel?.contains(target));
      if (index < 0 || !panels[index]!.hidden) return false;
      activate(index);
      return true;
    };
    const switchTab = (index: number, focus = false) => {
      activate(index, focus);
      // A switch from deep in a long panel starts at the new panel's beginning,
      // rather than stranding the reader among unrelated answers or controls.
      const panel = panels[index]!;
      if (
        panel.getBoundingClientRect().top < list.getBoundingClientRect().bottom
      )
        panel.scrollIntoView({ block: "start" });
    };
    list.dataset.tabsReady = "true";
    list.setAttribute("role", "tablist");
    tabs.forEach((tab, index) => {
      const panel = panels[index]!;
      tab.setAttribute("role", "tab");
      tab.setAttribute("aria-controls", panel.id);
      panel.setAttribute("role", "tabpanel");
      panel.setAttribute("aria-labelledby", tab.id);
      // Section headings label the no-JS page; tabs label the enhanced panels.
      const heading = panel.querySelector<HTMLElement>(
        "[data-volunteer-profile-panel-heading]",
      );
      if (heading) heading.hidden = true;
      panel.tabIndex = 0;
      tab.addEventListener("click", (event) => {
        if (
          event.button !== 0 ||
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey ||
          event.altKey
        )
          return;
        event.preventDefault();
        switchTab(index);
      });
      tab.addEventListener("keydown", (event) => {
        if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey)
          return;
        let next: number;
        switch (event.key) {
          case "ArrowRight":
            next = (index + 1) % tabs.length;
            break;
          case "ArrowLeft":
            next = (index - 1 + tabs.length) % tabs.length;
            break;
          case "Home":
            next = 0;
            break;
          case "End":
            next = tabs.length - 1;
            break;
          case " ":
            next = index;
            break;
          default:
            return;
        }
        event.preventDefault();
        switchTab(next, true);
      });
    });
    const hashTarget = () =>
      location.hash
        ? flow.querySelector<HTMLElement>(
            `#${CSS.escape(location.hash.slice(1))}`,
          )
        : null;
    const initial = tabs.findIndex((tab, index) =>
      selected
        ? tab.dataset.volunteerProfileTab === selected
        : panels[index]!.contains(hashTarget()),
    );
    activate(initial < 0 ? 0 : initial);
    const revealHash = () => {
      const target = hashTarget();
      // History navigation can target a panel which was hidden when the browser
      // first attempted its fragment jump. Reveal it, then finish that jump.
      if (target && revealTarget(target))
        target.scrollIntoView({ block: "start" });
    };
    window.addEventListener("hashchange", revealHash);
    const disposeContents = initPageContents(flow, {
      // Status updates preserve the selected tab, even if an earlier contents
      // jump left a fragment belonging to the other panel in the URL.
      initialHash: selected ? "" : undefined,
      scrollRoot:
        flow.closest<HTMLElement>("[data-profile-dialog-content]") ?? undefined,
      stickyNavigation: list,
      revealTarget,
    });
    disposers.set(list, () => {
      disposeContents?.();
      window.removeEventListener("hashchange", revealHash);
    });
  }
}
