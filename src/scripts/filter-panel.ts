const wide = matchMedia("(min-width: 64rem)");

/**
 * A list's filter and sort panel. On wide screens it sits beside the list and
 * applies each change at once. On small screens it opens as a modal sheet and
 * applies its choices when it closes.
 */
export function initFilterPanel(root: HTMLElement, apply: () => void) {
  const panel = root.querySelector<HTMLDialogElement>("[data-filter-panel]");
  const trigger = root.querySelector<HTMLElement>("[data-filter-panel-open]");
  if (!panel) return { update() {}, isOpen: () => false };
  const count = trigger?.querySelector<HTMLElement>(
    "[data-filter-panel-count]",
  );
  const reset = panel.querySelector<HTMLElement>("[data-filter-reset]");
  const checkboxes = () =>
    panel.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');

  /** Show how many filter options are chosen. */
  const update = () => {
    const active = [...checkboxes()].filter((input) => input.checked).length;
    trigger?.toggleAttribute("data-active", active > 0);
    if (count) {
      count.hidden = !active;
      count.firstChild!.textContent = String(active);
    }
    if (reset) reset.hidden = !active;
  };

  // Buttons open and close the sheet with invoker commands where supported.
  const commands = "command" in HTMLButtonElement.prototype;
  if (!commands) trigger?.addEventListener("click", () => panel.showModal());
  panel.addEventListener("click", (event) => {
    if (!(event.target instanceof Element)) return;
    const close = event.target.closest("[data-filter-panel-close]");
    // A click on the dialog itself lands on its backdrop.
    if (event.target === panel || close) {
      // Show results submits the form only when scripts are off.
      if (close?.matches('[type="submit"]')) event.preventDefault();
      if (!commands || !close?.hasAttribute("command")) panel.close();
    } else if (event.target.closest("[data-filter-reset]")) {
      event.preventDefault();
      for (const input of checkboxes()) input.checked = false;
      update();
      if (!panel.open) apply();
    }
  });
  panel.addEventListener("close", apply);
  panel.addEventListener("change", (event) => {
    if (
      event.target instanceof HTMLInputElement &&
      event.target.matches("[data-filter-search]")
    )
      return;
    update();
    if (!panel.open) apply();
  });
  panel.addEventListener("input", (event) => {
    if (!(event.target instanceof HTMLInputElement)) return;
    const search = event.target;
    if (!search.matches("[data-filter-search]")) return;
    const section = search.closest("[data-filter-section]")!;
    const term = search.value.trim().toLocaleLowerCase();
    let shown = 0;
    for (const option of section.querySelectorAll<HTMLElement>(
      "[data-filter-option]",
    )) {
      option.hidden = !option.textContent!.toLocaleLowerCase().includes(term);
      if (!option.hidden) shown++;
    }
    section.querySelector<HTMLElement>("[data-filter-empty]")!.hidden =
      shown > 0;
  });
  // The sheet becomes the sidebar when the screen widens.
  wide.addEventListener("change", () => {
    if (wide.matches && panel.open) panel.close();
  });
  update();
  return { update, isOpen: () => panel.open };
}
