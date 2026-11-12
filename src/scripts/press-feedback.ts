/** Wait before showing a press, so a touch that turns into a scroll never does. */
const delay = 100;
/** Finger travel, in pixels, that means a scroll rather than a tap. */
const slop = 8;
/** How long a quick tap stays lit, so the feedback is visible at all. */
const flash = 150;

/**
 * Touch press feedback for list items that never lights up the item a scroll
 * starts on. An item gets `data-pressed` only after a touch rests on it
 * briefly, or when a quick touch lifts without moving. Moving the finger, or
 * the browser taking the touch over for scrolling, cancels it.
 */
export function initPressFeedback(
  root: HTMLElement,
  selector: string,
  signal?: AbortSignal,
) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let item: HTMLElement | undefined;
  let start = { x: 0, y: 0 };

  const clear = () => {
    clearTimeout(timer);
    timer = undefined;
    item?.removeAttribute("data-pressed");
    item = undefined;
  };

  root.addEventListener("pointerdown", (event) => {
    clear();
    if (event.pointerType !== "touch" || !(event.target instanceof Element))
      return;
    const target = event.target.closest<HTMLElement>(selector);
    if (!target) return;
    item = target;
    start = { x: event.clientX, y: event.clientY };
    timer = setTimeout(() => {
      timer = undefined;
      target.setAttribute("data-pressed", "");
    }, delay);
  });
  root.addEventListener("pointermove", (event) => {
    if (
      item &&
      event.pointerType === "touch" &&
      Math.hypot(event.clientX - start.x, event.clientY - start.y) > slop
    )
      clear();
  });
  root.addEventListener("pointerup", (event) => {
    if (!item || event.pointerType !== "touch") return;
    const tapped = item;
    clearTimeout(timer);
    timer = undefined;
    tapped.setAttribute("data-pressed", "");
    setTimeout(() => {
      if (item === tapped) clear();
    }, flash);
  });
  root.addEventListener("pointercancel", clear);
  // A page restored from history must not keep an item lit.
  addEventListener("pageshow", clear, { signal });
  signal?.addEventListener("abort", clear, { once: true });
}
