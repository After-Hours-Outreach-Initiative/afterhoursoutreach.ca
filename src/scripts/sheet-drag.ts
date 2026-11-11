/**
 * Let a bottom sheet be dragged down by its top part. Releasing it far enough
 * down, or with a quick flick, closes it; otherwise it springs back.
 */
export function initSheetDrag(
  sheet: HTMLElement,
  handle: HTMLElement,
  close: () => void,
  active: () => boolean,
) {
  let pointer: number | null = null;
  let start = 0;
  let offset = 0;
  let lastY = 0;
  let lastTime = 0;
  let velocity = 0;

  const release = (dismiss: boolean) => {
    pointer = null;
    sheet.removeAttribute("data-dragging");
    // Restoring the transition with the position animates the settle.
    sheet.style.removeProperty("transition");
    sheet.style.removeProperty("translate");
    sheet.style.removeProperty("--sheet-drag");
    if (dismiss) close();
  };

  handle.addEventListener("pointerdown", (event) => {
    if (
      pointer !== null ||
      !active() ||
      event.button !== 0 ||
      (event.target instanceof Element &&
        event.target.closest("a, button, input"))
    )
      return;
    pointer = event.pointerId;
    start = lastY = event.clientY;
    lastTime = event.timeStamp;
    offset = velocity = 0;
    handle.setPointerCapture(pointer);
    sheet.setAttribute("data-dragging", "");
    sheet.style.transition = "none";
  });

  handle.addEventListener("pointermove", (event) => {
    if (event.pointerId !== pointer) return;
    offset = Math.max(0, event.clientY - start);
    const elapsed = event.timeStamp - lastTime;
    if (elapsed > 0) velocity = (event.clientY - lastY) / elapsed;
    lastY = event.clientY;
    lastTime = event.timeStamp;
    sheet.style.translate = `0 ${offset}px`;
    sheet.style.setProperty(
      "--sheet-drag",
      String(Math.min(1, offset / sheet.offsetHeight)),
    );
  });

  handle.addEventListener("pointerup", (event) => {
    if (event.pointerId !== pointer) return;
    release(offset > sheet.offsetHeight / 4 || (offset > 8 && velocity > 0.5));
  });
  handle.addEventListener("pointercancel", (event) => {
    if (event.pointerId === pointer) release(false);
  });
}
