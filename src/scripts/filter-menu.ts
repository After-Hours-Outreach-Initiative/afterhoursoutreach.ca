import { initSheetDrag } from "./sheet-drag";

const gap = 8;
const wide = matchMedia("(min-width: 64rem)");

/** Some menus become bottom sheets on small screens. */
const isSheet = (menu: HTMLElement) =>
  menu.hasAttribute("data-filter-menu-sheet") && !wide.matches;

/** Drop a menu's placement so its sheet styles apply. */
function unplace(menu: HTMLElement) {
  for (const property of ["left", "top", "max-height", "clip-path"])
    menu.style.removeProperty(property);
}

function triggerFor(menu: HTMLElement) {
  return document.getElementById(menu.getAttribute("aria-labelledby") ?? "");
}

/** Place a menu under its trigger in document coordinates. */
function place(menu: HTMLElement, trigger: HTMLElement) {
  const bounds = trigger.getBoundingClientRect();
  const viewport = document.documentElement.clientWidth;
  const width = menu.offsetWidth;
  const preferred =
    menu.dataset.filterMenuAlign === "end" ? bounds.right - width : bounds.left;
  const left = Math.max(gap, Math.min(preferred, viewport - width - gap));
  menu.style.left = `${left + scrollX}px`;
  menu.style.top = `${bounds.bottom + gap + scrollY}px`;
  menu.style.maxHeight = `${Math.max(12 * 16, innerHeight - bounds.bottom - gap * 2)}px`;
  clip(menu);
}

/**
 * Menus sit in the top layer, above the sticky site header. Clip the part of
 * an open menu that scrolls up behind the header so it passes under it.
 */
function clip(menu: HTMLElement) {
  const header = document.querySelector(".site-header");
  const edge = header?.getBoundingClientRect().bottom ?? 0;
  const hidden = edge - menu.getBoundingClientRect().top;
  if (hidden > 0) menu.style.clipPath = `inset(${hidden}px -3rem -3rem)`;
  else menu.style.removeProperty("clip-path");
}

const isOpen = (menu: HTMLElement) =>
  menu.matches(":popover-open") || (menu as HTMLDialogElement).open;

function hide(menu: HTMLDialogElement) {
  if (menu.open) menu.close();
  else if (menu.matches(":popover-open")) menu.hidePopover();
}

/**
 * On small screens a sheet menu opens as a modal dialog instead of a popover,
 * so the page beneath ignores taps, presses and holds until it closes. A tap
 * on the backdrop, a drag down, Escape or its own buttons close it.
 */
function initSheet(menu: HTMLDialogElement, signal?: AbortSignal) {
  const trigger = triggerFor(menu);
  trigger?.addEventListener("click", (event) => {
    if (!isSheet(menu)) return;
    // Cancels the trigger's popover toggle.
    event.preventDefault();
    if (menu.open) return menu.close();
    unplace(menu);
    menu.showModal();
    trigger.setAttribute("aria-expanded", "true");
  });
  menu.addEventListener("close", () =>
    trigger?.setAttribute("aria-expanded", "false"),
  );
  menu.addEventListener("click", (event) => {
    if (!(event.target instanceof Element)) return;
    // A click on the dialog itself lands on its backdrop.
    if (
      (event.target === menu && menu.open) ||
      event.target.closest("[data-sheet-close]")
    )
      hide(menu);
  });
  const handle = menu.querySelector<HTMLElement>("[data-sheet-handle]");
  if (handle)
    initSheetDrag(
      menu,
      handle,
      () => hide(menu),
      () => isOpen(menu) && isSheet(menu),
    );
  // The sheet becomes a menu when the screen widens, and the reverse.
  wide.addEventListener("change", () => hide(menu), { signal });
}

/**
 * Popover menus placed under their triggers. Closing a menu reports it to the
 * page.
 */
export function initFilterMenus(
  root: HTMLElement,
  onClose: (menu: HTMLElement) => void,
  signal?: AbortSignal,
) {
  for (const menu of root.querySelectorAll<HTMLElement>("[data-filter-menu]")) {
    menu.addEventListener("beforetoggle", (event) => {
      const open = (event as ToggleEvent).newState === "open";
      const trigger = triggerFor(menu);
      trigger?.setAttribute("aria-expanded", String(open));
      if (!open || !trigger) return;
      if (isSheet(menu)) return unplace(menu);
      // The menu is not laid out yet. Hide it until it is placed in the frame
      // before its first paint, so it never flashes at the page origin.
      menu.style.visibility = "hidden";
      requestAnimationFrame(() => {
        if (!menu.matches(":popover-open")) return;
        place(menu, trigger);
        menu.style.removeProperty("visibility");
      });
    });
    if (menu instanceof HTMLDialogElement) initSheet(menu, signal);
    menu.addEventListener("toggle", (event) => {
      if ((event as ToggleEvent).newState === "open") {
        // Skip focusing search on touch screens, where it opens the keyboard.
        if (matchMedia("(pointer: fine)").matches)
          menu.querySelector<HTMLInputElement>("[data-filter-search]")?.focus();
      } else onClose(menu);
    });
  }

  root.addEventListener("input", (event) => {
    if (!(event.target instanceof HTMLInputElement)) return;
    const search = event.target;
    if (!search.matches("[data-filter-search]")) return;
    const menu = search.closest("[data-filter-menu]")!;
    const term = search.value.trim().toLocaleLowerCase();
    let shown = 0;
    for (const option of menu.querySelectorAll<HTMLElement>(
      "[data-filter-option]",
    )) {
      option.hidden = !option.textContent!.toLocaleLowerCase().includes(term);
      if (!option.hidden) shown++;
    }
    const empty = menu.querySelector<HTMLElement>("[data-filter-empty]");
    if (empty) empty.hidden = shown > 0;
  });

  addEventListener(
    "scroll",
    () => {
      for (const menu of root.querySelectorAll<HTMLElement>(
        "[data-filter-menu]:popover-open",
      ))
        if (!isSheet(menu)) clip(menu);
    },
    { passive: true, signal },
  );

  addEventListener(
    "resize",
    () => {
      for (const menu of root.querySelectorAll<HTMLElement>(
        "[data-filter-menu]:popover-open",
      )) {
        const trigger = triggerFor(menu);
        if (isSheet(menu)) unplace(menu);
        else if (trigger) place(menu, trigger);
      }
    },
    { signal },
  );
}
