/** Scroll back up this far, in pixels, before the link offers itself. */
const upward = 24;

/**
 * A "Back to top" link that appears once a reader is more than a screen down
 * a page and starts scrolling back up. Scrolling down or nearing the top hides
 * it again, so it never covers content while reading onward.
 */
const link = document.querySelector<HTMLAnchorElement>("[data-back-to-top]");
if (link) {
  // The lowest point since the reader last scrolled down, and the last position.
  let anchor = scrollY;
  let last = scrollY;
  const show = (visible: boolean) => {
    link.toggleAttribute("data-visible", visible);
    link.inert = !visible;
  };
  addEventListener(
    "scroll",
    () => {
      const y = scrollY;
      if (y < innerHeight || y > last) {
        // Near the top, or reading onward: hide, and measure from here.
        show(false);
        anchor = y;
      } else if (anchor - y > upward) show(true);
      last = y;
    },
    { passive: true },
  );
  link.addEventListener("click", (event) => {
    event.preventDefault();
    show(false);
    scrollTo({
      top: 0,
      behavior: matchMedia("(prefers-reduced-motion: reduce)").matches
        ? "auto"
        : "smooth",
    });
    // Keyboard and screen reader users continue from the top of the content.
    document.getElementById("main-content")?.focus({ preventScroll: true });
  });
}
