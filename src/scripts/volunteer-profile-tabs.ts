/** Enhance ordinary section links; both sections remain readable without JS. */
export function initVolunteerProfileTabs(
  root: Document | HTMLElement = document,
  selected?: string,
) {
  for (const list of root.querySelectorAll<HTMLElement>(
    "[data-volunteer-profile-tabs]:not([data-tabs-ready])",
  )) {
    const tabs = [
      ...list.querySelectorAll<HTMLAnchorElement>(
        "[data-volunteer-profile-tab]",
      ),
    ];
    const panels = tabs.map((tab) => root.querySelector<HTMLElement>(tab.hash));
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
    list.dataset.tabsReady = "true";
    list.setAttribute("role", "tablist");
    tabs.forEach((tab, index) => {
      const panel = panels[index]!;
      tab.setAttribute("role", "tab");
      tab.setAttribute("aria-controls", panel.id);
      panel.setAttribute("role", "tabpanel");
      panel.setAttribute("aria-labelledby", tab.id);
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
        activate(index);
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
        activate(next, true);
      });
    });
    const initial = tabs.findIndex((tab) =>
      selected
        ? tab.dataset.volunteerProfileTab === selected
        : tab.hash === location.hash,
    );
    activate(initial < 0 ? 0 : initial);
  }
}
