/** Shared by the floating link and tapping the current app tab. */
export function scrollToPageTop() {
  for (const link of document.querySelectorAll<HTMLElement>(
    "[data-back-to-top]",
  )) {
    link.removeAttribute("data-visible");
    link.inert = true;
  }
  scrollTo({
    top: 0,
    behavior: matchMedia("(prefers-reduced-motion: reduce)").matches
      ? "auto"
      : "smooth",
  });
  document.getElementById("main-content")?.focus({ preventScroll: true });
}
