import { onPageLoad } from "./page-lifecycle";
import { scrollToPageTop } from "./scroll-to-top";
onPageLoad((page) => {
  if (!document.querySelector("[data-back-to-top]")) return;
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
    const position = () => {
      const header = document.querySelector<HTMLElement>(".site-header");
      const headerPosition = header && getComputedStyle(header).position;
      let edge =
        header && (headerPosition === "sticky" || headerPosition === "fixed")
          ? Math.max(0, header.getBoundingClientRect().bottom)
          : 0;
      const gap =
        parseFloat(getComputedStyle(document.documentElement).fontSize) * 0.75;
      const linkBounds = link.getBoundingClientRect();
      for (const bar of document.querySelectorAll<HTMLElement>(
        "[data-contents-bar]",
      )) {
        const bounds = bar.getBoundingClientRect();
        if (
          bounds.width > 0 &&
          bounds.height > 0 &&
          bounds.right > linkBounds.left &&
          bounds.left < linkBounds.right &&
          bounds.bottom > edge &&
          bounds.top < edge + gap + linkBounds.height
        )
          edge = Math.max(edge, bounds.bottom);
      }
      link.style.setProperty("--back-to-top-offset", `${edge}px`);
    };
    const show = (visible: boolean) => {
      if (visible) position();
      link.toggleAttribute("data-visible", visible);
      link.inert = !visible;
    };
    page.onWindow(
      "scroll",
      () => {
        if (link.hasAttribute("data-visible")) position();
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
    const resize = new ResizeObserver(position);
    for (const element of document.querySelectorAll(
      ".site-header, [data-contents-bar]",
    ))
      resize.observe(element);
    page.cleanup(() => resize.disconnect());
    page.onWindow("resize", position);
    page.onDocument("toggle", position, true);
    page.onDocument("account-content-updated", position);
    position();

    link.addEventListener("click", (event) => {
      event.preventDefault();
      show(false);
      scrollToPageTop();
    });
  }
});
