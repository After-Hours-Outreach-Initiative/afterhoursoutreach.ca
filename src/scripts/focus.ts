/** Make static update targets focusable only while they actually hold focus. */
export function focusAfterUpdate(target: HTMLElement | null) {
  if (!target) return;
  if (target.tabIndex < 0 && !target.hasAttribute("tabindex")) {
    target.tabIndex = -1;
    target.addEventListener("blur", () => target.removeAttribute("tabindex"), {
      once: true,
    });
  }
  target.focus({ preventScroll: true });
}
