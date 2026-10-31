// Keep the original semantic header and horizontal scroll frame. Prefer native
// sticky positioning; overflowing tables can use a compositor-driven timeline.
export function initDirectoryTableHeader(results: HTMLElement) {
  const siteHeader = document.querySelector<HTMLElement>(".site-header");
  const scrollDriven =
    CSS.supports("animation-timeline: scroll(root block)") &&
    CSS.supports("animation-range: 0px 1px");
  let frame: HTMLElement | null = null;
  let table: HTMLTableElement | null = null;
  let head: HTMLTableSectionElement | null = null;
  let scheduled: number | undefined;
  let needsMeasurement = true;
  let active = true;
  let mode: "native" | "timeline" | "fallback" = "native";
  let start = 0;
  let travel = 0;
  let lastShift = -1;

  const update = () => {
    scheduled = undefined;
    if (!frame?.isConnected || !table || !head) return;
    if (needsMeasurement) {
      // All geometry reads precede style writes, and only happen on layout
      // changes. A scroll frame only reads scrollY, never DOM geometry.
      const bounds = table.getBoundingClientRect();
      const top = siteHeader?.getBoundingClientRect().height ?? 0;
      const headHeight = head.getBoundingClientRect().height;
      const overflowing = table.scrollWidth > frame.clientWidth;
      start = bounds.top + window.scrollY - top;
      travel = Math.max(0, bounds.height - headHeight);
      mode = !overflowing
        ? "native"
        : scrollDriven && travel > 0
          ? "timeline"
          : "fallback";
      needsMeasurement = false;
      lastShift = -1;

      window.removeEventListener("scroll", schedule);
      if (travel > 0)
        window.addEventListener("scroll", schedule, { passive: true });
      frame.tabIndex = overflowing ? 0 : -1;
      frame.style.setProperty("--directory-table-header-top", `${top}px`);
      if (mode === "timeline") {
        head.style.setProperty("--directory-table-header-start", `${start}px`);
        head.style.setProperty(
          "--directory-table-header-end",
          `${start + travel}px`,
        );
        head.style.setProperty(
          "--directory-table-header-travel",
          `${travel}px`,
        );
      }
      if (mode !== "fallback") head.style.removeProperty("transform");
      frame.dataset.tableHeader = mode;
    }
    const shift = Math.max(0, Math.min(window.scrollY - start, travel));
    const stuck = String(shift > 0);
    // Only the corner state changes at the sticky edge; native/timeline modes
    // still leave all header positioning to the browser.
    if (frame.dataset.headerStuck !== stuck) frame.dataset.headerStuck = stuck;
    if (mode === "fallback") {
      if (shift !== lastShift) {
        head.style.transform = `translate3d(0, ${shift}px, 0)`;
        lastShift = shift;
      }
    }
  };
  function schedule() {
    if (active) scheduled ??= requestAnimationFrame(update);
  }
  const measure = () => {
    needsMeasurement = true;
    schedule();
  };
  // Observe actual layout changes, not height-only viewport resize events from
  // mobile browser toolbars animating during a scroll.
  const observer = new ResizeObserver(measure);
  const refresh = () => {
    observer.disconnect();
    window.removeEventListener("scroll", schedule);
    if (scheduled !== undefined) cancelAnimationFrame(scheduled);
    scheduled = undefined;
    frame = results.querySelector<HTMLElement>(".volunteer-table-frame");
    table = frame?.querySelector<HTMLTableElement>("table") ?? null;
    head = table?.tHead ?? null;
    if (!frame || !table || !head) return;
    observer.observe(frame);
    observer.observe(table);
    observer.observe(head);
    // Include filters/search errors above the table when caching its page offset.
    observer.observe(results.closest("[data-volunteer-browser]") ?? results);
    if (siteHeader) observer.observe(siteHeader);
    measure();
  };
  const resume = () => {
    active = true;
    refresh();
  };
  window.addEventListener("pagehide", () => {
    active = false;
    observer.disconnect();
    if (scheduled !== undefined) cancelAnimationFrame(scheduled);
    scheduled = undefined;
    window.removeEventListener("scroll", schedule);
  });
  window.addEventListener("pageshow", (event) => {
    if (event.persisted) resume();
  });
  resume();
  return refresh;
}
