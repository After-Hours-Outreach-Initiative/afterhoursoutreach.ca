/** Delegation also covers rosters replaced by live event refreshes. */
export function initSignupMenus() {
  const triggerFor = (menu: HTMLElement) =>
    document.getElementById(menu.getAttribute("aria-labelledby") ?? "");
  const itemsFor = (menu: HTMLElement) => [
    ...menu.querySelectorAll<HTMLButtonElement>(
      '[role="menuitem"]:not(:disabled)',
    ),
  ];
  const positionMenu = (menu: HTMLElement, trigger: HTMLElement) => {
    const bounds = trigger.getBoundingClientRect();
    const gap = 8;
    menu.style.left = `${Math.max(gap, Math.min(bounds.right - menu.offsetWidth, innerWidth - menu.offsetWidth - gap))}px`;
    menu.style.top = `${Math.max(gap, Math.min(bounds.bottom + gap, innerHeight - menu.offsetHeight - gap))}px`;
  };

  document.addEventListener(
    "toggle",
    (event) => {
      const menu = event.target;
      if (!(menu instanceof HTMLElement) || !menu.matches("[data-signup-menu]"))
        return;
      const trigger = triggerFor(menu);
      const open = menu.matches(":popover-open");
      trigger?.setAttribute("aria-expanded", String(open));
      if (!open || !trigger) return;
      positionMenu(menu, trigger);
      if (!menu.contains(document.activeElement)) itemsFor(menu)[0]?.focus();
    },
    true,
  );

  document.addEventListener("keydown", (event) => {
    if (!(event.target instanceof Element)) return;
    const trigger = event.target.closest<HTMLButtonElement>(
      "[data-signup-menu-trigger]",
    );
    if (trigger && ["ArrowDown", "ArrowUp"].includes(event.key)) {
      event.preventDefault();
      const menu = trigger.popoverTargetElement;
      if (!(menu instanceof HTMLElement)) return;
      if (!menu.matches(":popover-open")) trigger.click();
      const items = itemsFor(menu);
      (event.key === "ArrowUp" ? items.at(-1) : items[0])?.focus();
      return;
    }
    const menu = event.target.closest<HTMLElement>("[data-signup-menu]");
    if (!menu) return;
    const items = itemsFor(menu);
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      const next =
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? items.length - 1
            : (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) %
              items.length;
      items[next]?.focus();
    } else if (event.key === "Tab") {
      // Resume the normal tab order from the row's invoker, not the hidden menu.
      menu.hidePopover();
      triggerFor(menu)?.focus();
    }
    // Native auto popovers provide Escape, light dismissal and focus return.
  });

  document.addEventListener("click", (event) => {
    if (!(event.target instanceof Element)) return;
    const item = event.target.closest<HTMLButtonElement>(
      "[data-signup-change]",
    );
    const menu = item?.closest<HTMLElement>("[data-signup-menu]");
    if (!item || !menu) return;
    const dialog = document.getElementById(item.dataset.showDialog ?? "");
    if (!(dialog instanceof HTMLDialogElement)) return;
    const destination = dialog.querySelector('[name="destination"]');
    if (destination instanceof HTMLSelectElement)
      destination.value =
        item.dataset.signupChange === "move"
          ? (destination.options[1]?.value ?? "")
          : "";
    menu.hidePopover();
    // The existing dialog handler runs next. Native dialog close will then
    // restore focus to this visible invoker rather than a hidden menu item.
    triggerFor(menu)?.focus();
  });

  const reposition = () => {
    for (const menu of document.querySelectorAll<HTMLElement>(
      "[data-signup-menu]:popover-open",
    )) {
      const trigger = triggerFor(menu);
      if (trigger) positionMenu(menu, trigger);
    }
  };
  window.addEventListener("resize", reposition);
  document.addEventListener("scroll", reposition, true);
}
