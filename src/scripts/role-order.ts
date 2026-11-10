const itemSelector = "[data-role-order-item]";
/** How much of a neighbour the dragged item covers before they swap. */
const reach = 1 / 3;

/** Wait for an element's running transitions, however they end. */
async function settled(element: HTMLElement) {
  // Read the style so a transition just started is already listed.
  void getComputedStyle(element).transform;
  await Promise.allSettled(
    element.getAnimations().map((animation) => animation.finished),
  );
}

/**
 * A reorderable role list. Drag an item to move it: it follows the pointer,
 * the other items slide out of its way, and a slot marks where it will land.
 * A focused item also moves with the up and down arrow keys. The order is
 * written to the menu's hidden `order` input.
 */
export function initRoleOrder(menu: HTMLElement) {
  const section = menu.querySelector<HTMLElement>("[data-role-order]");
  const list = menu.querySelector<HTMLOListElement>("[data-role-order-list]");
  const input = menu.querySelector<HTMLInputElement>('input[name="order"]');
  const status = menu.querySelector<HTMLElement>("[data-role-order-status]");
  if (!section || !list || !input) return () => {};
  const items = () => [...list.querySelectorAll<HTMLElement>(itemSelector)];
  let busy = false;

  const sync = () => {
    input.value = items()
      .map((item) => item.dataset.roleOrderItem)
      .join(",");
  };
  const announce = (item: HTMLElement) => {
    if (!status) return;
    const all = items();
    status.textContent = `${item.getAttribute("aria-label")} moved to position ${all.indexOf(item) + 1} of ${all.length}.`;
  };
  /** Drop transforms at once, without animating back to the layout. */
  const resetTransforms = () => {
    for (const item of items()) {
      item.style.transition = "none";
      item.style.removeProperty("transform");
    }
    void list.offsetHeight;
    for (const item of items()) item.style.removeProperty("transition");
  };

  menu.addEventListener("change", (event) => {
    if (
      event.target instanceof HTMLInputElement &&
      event.target.name === "sort"
    )
      section.hidden = event.target.value !== "role";
  });

  list.addEventListener("keydown", (event) => {
    if (busy || !(event.target instanceof HTMLElement)) return;
    const item = event.target.closest<HTMLElement>(itemSelector);
    if (!item || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return;
    event.preventDefault();
    const up = event.key === "ArrowUp";
    const neighbour = up
      ? item.previousElementSibling
      : item.nextElementSibling;
    if (!(neighbour instanceof HTMLElement)) return;
    const before = new Map(
      items().map((other) => [other, other.getBoundingClientRect().top]),
    );
    // Move the neighbour rather than the focused item, which would lose focus.
    // insertBefore: the Workers types shadow the DOM's variadic before/after.
    if (up) list.insertBefore(neighbour, item.nextElementSibling);
    else list.insertBefore(neighbour, item);
    // Start each item where it was, then let it slide to its new place.
    for (const [other, top] of before) {
      other.style.transition = "none";
      other.style.transform = `translateY(${top - other.getBoundingClientRect().top}px)`;
    }
    void list.offsetHeight;
    for (const other of before.keys()) {
      other.style.removeProperty("transition");
      other.style.removeProperty("transform");
    }
    sync();
    announce(item);
  });

  list.addEventListener("pointerdown", (event) => {
    if (busy || !(event.target instanceof Element) || event.button !== 0)
      return;
    const item = event.target.closest<HTMLElement>(itemSelector);
    if (!item) return;
    event.preventDefault();
    busy = true;
    item.setPointerCapture(event.pointerId);

    const all = items();
    const from = all.indexOf(item);
    const rects = all.map((other) => other.getBoundingClientRect());
    const listTop = list.getBoundingClientRect().top;
    const gap = parseFloat(getComputedStyle(list).rowGap) || 0;
    const first = rects[0].top;
    const last = rects[rects.length - 1].bottom;
    const own = rects[from];
    let target = from;
    let landing = own.top;

    const slot = document.createElement("div");
    slot.className = "directory-role-order-slot";
    slot.setAttribute("aria-hidden", "true");
    slot.style.height = `${own.height}px`;
    slot.style.transform = `translateY(${own.top - listTop}px)`;
    list.appendChild(slot);
    item.dataset.dragging = "";

    /** Slide the other items to make room at `target`, and mark the slot. */
    const layout = () => {
      const order = all.filter((other) => other !== item);
      order.splice(target, 0, item);
      let top = first;
      for (const other of order) {
        const rect = rects[all.indexOf(other)];
        if (other === item) landing = top;
        else other.style.transform = `translateY(${top - rect.top}px)`;
        top += rect.height + gap;
      }
      slot.style.transform = `translateY(${landing - listTop}px)`;
    };

    const move = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId !== event.pointerId) return;
      const pointer = moveEvent.clientY - event.clientY;
      const min = first - own.top;
      const max = last - own.bottom;
      // Past the ends of the list the item gives a little instead of stopping.
      const give = (excess: number) => 8 * (1 - 1 / (1 + excess / 40));
      const offset =
        pointer < min
          ? min - give(min - pointer)
          : pointer > max
            ? max + give(pointer - max)
            : pointer;
      item.style.transform = `translateY(${offset}px)`;
      // Swap with a neighbour once the item covers a third of it.
      const top = own.top + offset;
      const bottom = own.bottom + offset;
      const next = rects.filter((rect, index) =>
        index < from
          ? top > rect.bottom - rect.height * reach
          : index > from && bottom > rect.top + rect.height * reach,
      ).length;
      if (next !== target) {
        target = next;
        layout();
      }
    };

    const end = async (endEvent: PointerEvent) => {
      if (endEvent.pointerId !== event.pointerId) return;
      item.removeEventListener("pointermove", move);
      item.removeEventListener("pointerup", end);
      item.removeEventListener("pointercancel", end);
      item.removeEventListener("lostpointercapture", end);
      // Glide into the marked slot, then commit the order to the DOM.
      delete item.dataset.dragging;
      item.dataset.dropping = "";
      item.style.transform = `translateY(${landing - own.top}px)`;
      await settled(item);
      const focused = document.activeElement === item;
      const others = all.filter((other) => other !== item);
      list.insertBefore(item, others[target] ?? slot);
      slot.remove();
      resetTransforms();
      delete item.dataset.dropping;
      if (focused) item.focus({ preventScroll: true });
      busy = false;
      sync();
      if (target !== from) announce(item);
    };

    item.addEventListener("pointermove", move);
    item.addEventListener("pointerup", end);
    item.addEventListener("pointercancel", end);
    item.addEventListener("lostpointercapture", end);
  });

  sync();
  /** Show a saved order, as when the page restores another state. */
  return (order: readonly string[], sort: string) => {
    for (const role of order) {
      const item = list.querySelector(`[data-role-order-item="${role}"]`);
      if (item) list.appendChild(item);
    }
    section.hidden = sort !== "role";
    sync();
  };
}
