import "../styles/compact-person-name.css";

let initialized = false;

export function initCompactPersonNames() {
  if (initialized) return;
  initialized = true;
  // Initialize from the page controller, even if its first result/roster is empty.
  // One top-layer disclosure handles sorted/filtered/live rows without setup.
  const tooltip = document.createElement("div");
  tooltip.className = "compact-person-name-tooltip";
  tooltip.popover = "manual";
  // The trigger already has the full accessible name; don't announce it twice.
  tooltip.setAttribute("aria-hidden", "true");
  document.body.appendChild(tooltip);

  let hovered: HTMLElement | null = null;
  let focused: HTMLElement | null = null;
  let active: HTMLElement | null = null;
  let dismissed: HTMLElement | null = null;
  let tooltipHovered = false;
  let timer: number | undefined;
  const triggerFor = (target: EventTarget | null) =>
    target instanceof Element
      ? target.closest<HTMLElement>("[data-compact-person-name]")
      : null;

  function hide() {
    clearTimeout(timer);
    tooltip.hidePopover();
    active = null;
    tooltipHovered = false;
    observer.disconnect();
  }

  function position() {
    if (!active) return;
    const bounds = active.getBoundingClientRect();
    const gap = 8;
    tooltip.style.left = `${Math.max(gap, Math.min(bounds.left, innerWidth - tooltip.offsetWidth - gap))}px`;
    const top =
      bounds.bottom + gap + tooltip.offsetHeight <= innerHeight - gap
        ? bounds.bottom + gap
        : bounds.top - tooltip.offsetHeight - gap;
    tooltip.style.top = `${Math.max(gap, Math.min(top, innerHeight - tooltip.offsetHeight - gap))}px`;
  }

  const observer = new MutationObserver(() => {
    if (active && !active.isConnected) {
      hovered = focused = dismissed = null;
      hide();
    }
  });

  function update() {
    clearTimeout(timer);
    if (hovered && !hovered.isConnected) hovered = null;
    if (focused && !focused.isConnected) focused = null;
    const next = hovered ?? focused;
    if (dismissed && dismissed !== hovered && dismissed !== focused)
      dismissed = null;
    if (!next || next === dismissed) {
      if (!tooltipHovered) hide();
      return;
    }
    if (active === next) return;
    active = next;
    tooltip.textContent = next.dataset.compactPersonName ?? "";
    tooltip.showPopover();
    position();
    observer.observe(document.body, { childList: true, subtree: true });
  }

  const scheduleUpdate = () => {
    clearTimeout(timer);
    // Keep the disclosure reachable while crossing the small pointer gap.
    timer = window.setTimeout(update, 100);
  };

  document.addEventListener("pointerover", (event) => {
    const trigger = triggerFor(event.target);
    if (!trigger || triggerFor(event.relatedTarget) === trigger) return;
    hovered = trigger;
    update();
  });
  document.addEventListener("pointerout", (event) => {
    const trigger = triggerFor(event.target);
    if (!trigger || triggerFor(event.relatedTarget) === trigger) return;
    if (hovered === trigger) hovered = null;
    scheduleUpdate();
  });
  document.addEventListener("focusin", (event) => {
    focused = triggerFor(event.target);
    update();
  });
  document.addEventListener("focusout", () => {
    focused = null;
    scheduleUpdate();
  });
  tooltip.addEventListener("pointerenter", () => {
    tooltipHovered = true;
    clearTimeout(timer);
  });
  tooltip.addEventListener("pointerleave", () => {
    tooltipHovered = false;
    scheduleUpdate();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || !active) return;
    dismissed = active;
    hide();
  });
  document.addEventListener("scroll", position, true);
  window.addEventListener("resize", position);
  window.addEventListener("pagehide", hide);
}
