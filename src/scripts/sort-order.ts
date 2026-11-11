const itemSelector = "[data-sort-order-item]";
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
 * A reorderable list of a sort's values, such as roles or statuses. Drag an
 * item to move it: it follows the pointer, the other items slide out of its
 * way, and a slot marks where it will land. A focused item also moves with the
 * up and down arrow keys. The order is written to the section's hidden input,
 * which reports each move as a change.
 */
function initSortOrder(section: HTMLElement) {
  const list = section.querySelector<HTMLOListElement>(
    "[data-sort-order-list]",
  );
  const input = section.querySelector<HTMLInputElement>('input[type="hidden"]');
  const status = section.querySelector<HTMLElement>("[data-sort-order-status]");
  if (!list || !input) return () => {};
  const items = () => [...list.querySelectorAll<HTMLElement>(itemSelector)];
  let busy = false;

  const reset = section.querySelector<HTMLElement>("[data-sort-order-reset]");
  const defaults = section.dataset.sortOrderDefault ?? "";
  const sync = () => {
    input.value = items()
      .map((item) => item.dataset.sortOrderItem)
      .join(",");
    // Offer a reset only while the order differs from the default.
    if (reset) reset.hidden = input.value === defaults;
  };
  /** Put the items in `order`, sliding each from where it was. */
  const arrange = (order: readonly string[]) => {
    const before = new Map(
      items().map((item) => [item, item.getBoundingClientRect().top]),
    );
    for (const value of order) {
      const item = list.querySelector(`[data-sort-order-item="${value}"]`);
      if (item) list.appendChild(item);
    }
    for (const [item, top] of before) {
      item.style.transition = "none";
      item.style.transform = `translateY(${top - item.getBoundingClientRect().top}px)`;
    }
    void list.offsetHeight;
    for (const item of before.keys()) {
      item.style.removeProperty("transition");
      item.style.removeProperty("transform");
    }
  };
  /** Report a move a person made, as a changed control does. */
  const moved = () => {
    sync();
    input.dispatchEvent(new Event("change", { bubbles: true }));
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

  reset?.addEventListener("click", () => {
    if (busy) return;
    // The reset button hides, so keep focus in the list.
    const first = items()[0];
    arrange(defaults.split(","));
    moved();
    (items()[0] ?? first)?.focus({ preventScroll: true });
    if (status) status.textContent = "Order reset to the default.";
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
    moved();
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
    slot.className = "directory-sort-order-slot";
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
      if (target === from) return;
      moved();
      announce(item);
    };

    item.addEventListener("pointermove", move);
    item.addEventListener("pointerup", end);
    item.addEventListener("pointercancel", end);
    item.addEventListener("lostpointercapture", end);
  });

  sync();
  /** Show a saved order, as when the page restores another state. */
  return (order: readonly string[]) => {
    const current = items().map((item) => item.dataset.sortOrderItem);
    // Moving items drops focus, so leave an unchanged order alone.
    if (order.join(",") !== current.join(",")) {
      const focused = document.activeElement;
      for (const value of order) {
        const item = list.querySelector(`[data-sort-order-item="${value}"]`);
        if (item) list.appendChild(item);
      }
      if (focused instanceof HTMLElement && list.contains(focused))
        focused.focus({ preventScroll: true });
    }
    sync();
  };
}

/**
 * Each sort with a custom order shows its reorderable list while that sort is
 * chosen. Returns a function that shows saved orders, keyed by input name.
 */
export function initSortOrders(menu: HTMLElement) {
  const sections = [
    ...menu.querySelectorAll<HTMLElement>("[data-sort-order]"),
  ].map((section) => ({ section, show: initSortOrder(section) }));
  const reveal = (sort: string) => {
    for (const { section } of sections)
      section.hidden = section.dataset.sortOrder !== sort;
  };
  menu.addEventListener("change", (event) => {
    if (
      event.target instanceof HTMLInputElement &&
      event.target.name === "sort"
    )
      reveal(event.target.value);
  });
  return (orders: Record<string, readonly string[]>, sort: string) => {
    for (const { section, show } of sections) {
      const name = section.querySelector<HTMLInputElement>(
        'input[type="hidden"]',
      )!.name;
      if (orders[name]) show(orders[name]);
    }
    reveal(sort);
  };
}
