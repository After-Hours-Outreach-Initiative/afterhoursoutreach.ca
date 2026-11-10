/**
 * A reorderable role list: drag an item by its handle, or use its move buttons.
 * The order is written to the menu's hidden `order` input.
 */
export function initRoleOrder(menu: HTMLElement) {
  const section = menu.querySelector<HTMLElement>("[data-role-order]");
  const list = menu.querySelector<HTMLOListElement>("[data-role-order-list]");
  const input = menu.querySelector<HTMLInputElement>('input[name="order"]');
  if (!section || !list || !input) return () => {};
  const items = () => [...list.children] as HTMLElement[];
  const sync = () => {
    const current = items();
    input.value = current.map((item) => item.dataset.roleOrderItem).join(",");
    current.forEach((item, index) => {
      item.querySelector<HTMLButtonElement>(
        '[data-role-order-move="up"]',
      )!.disabled = index === 0;
      item.querySelector<HTMLButtonElement>(
        '[data-role-order-move="down"]',
      )!.disabled = index === current.length - 1;
    });
  };

  menu.addEventListener("change", (event) => {
    if (
      event.target instanceof HTMLInputElement &&
      event.target.name === "sort"
    )
      section.hidden = event.target.value !== "role";
  });

  list.addEventListener("click", (event) => {
    if (!(event.target instanceof Element)) return;
    const button = event.target.closest<HTMLButtonElement>(
      "[data-role-order-move]",
    );
    if (!button || button.disabled) return;
    const item = button.closest<HTMLElement>("[data-role-order-item]")!;
    const up = button.dataset.roleOrderMove === "up";
    // insertBefore: the Workers types shadow the DOM's variadic before/after.
    if (up && item.previousElementSibling)
      list.insertBefore(item, item.previousElementSibling);
    else if (!up && item.nextElementSibling)
      list.insertBefore(item.nextElementSibling, item);
    sync();
    // Moving the item drops focus; keep it on a move button that still works.
    const opposite = item.querySelector<HTMLButtonElement>(
      `[data-role-order-move="${up ? "down" : "up"}"]`,
    )!;
    (button.disabled ? opposite : button).focus();
  });

  list.addEventListener("pointerdown", (event) => {
    if (!(event.target instanceof Element) || event.button !== 0) return;
    const handle = event.target.closest("[data-role-order-handle]");
    if (!handle) return;
    const item = handle.closest<HTMLElement>("[data-role-order-item]")!;
    event.preventDefault();
    item.dataset.dragging = "";
    // Window listeners survive the DOM moves that would release pointer capture.
    const move = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId !== event.pointerId) return;
      const others = items().filter((other) => other !== item);
      const index = others.filter((other) => {
        const bounds = other.getBoundingClientRect();
        return bounds.top + bounds.height / 2 < moveEvent.clientY;
      }).length;
      const reference = others[index] ?? null;
      if (item.nextElementSibling !== reference)
        list.insertBefore(item, reference);
    };
    const end = (endEvent: PointerEvent) => {
      if (endEvent.pointerId !== event.pointerId) return;
      delete item.dataset.dragging;
      removeEventListener("pointermove", move);
      removeEventListener("pointerup", end);
      removeEventListener("pointercancel", end);
      sync();
    };
    addEventListener("pointermove", move);
    addEventListener("pointerup", end);
    addEventListener("pointercancel", end);
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
