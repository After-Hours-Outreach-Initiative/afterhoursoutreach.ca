// Keep one semantic header, moving it only when horizontal overflow prevents
// native page-sticky positioning. The frame always retains its full row height.
export function initDirectoryTableHeader(results: HTMLElement) {
  const siteHeader = document.querySelector<HTMLElement>(".site-header");
  let frame: HTMLElement | null;
  let table: HTMLTableElement | null;
  let head: HTMLTableSectionElement | null;
  let scheduled: number | undefined;

  const update = () => {
    scheduled = undefined;
    if (!frame?.isConnected || !table || !head) return;
    const overflowing = table.scrollWidth > frame.clientWidth;
    frame.dataset.horizontalOverflow = String(overflowing);
    frame.tabIndex = overflowing ? 0 : -1;
    if (!overflowing) {
      head.style.removeProperty("--directory-table-header-shift");
      return;
    }
    const bounds = table.getBoundingClientRect();
    const top = siteHeader?.getBoundingClientRect().height ?? 0;
    const shift = Math.max(
      0,
      Math.min(
        top - bounds.top,
        bounds.height - head.getBoundingClientRect().height,
      ),
    );
    head.style.setProperty("--directory-table-header-shift", `${shift}px`);
  };
  const schedule = () => {
    scheduled ??= requestAnimationFrame(update);
  };
  const observer = new ResizeObserver(schedule);
  const refresh = () => {
    // Sorting and filtering replace the results subtree. Release old nodes
    // before measuring and observing the new table (also used by the playground).
    observer.disconnect();
    if (scheduled !== undefined) cancelAnimationFrame(scheduled);
    scheduled = undefined;
    frame = results.querySelector<HTMLElement>(".volunteer-table-frame");
    table = frame?.querySelector<HTMLTableElement>("table") ?? null;
    head = table?.tHead ?? null;
    if (!frame || !table || !head) return;
    observer.observe(frame);
    observer.observe(table);
    if (siteHeader) observer.observe(siteHeader);
    update();
  };
  const resume = () => {
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    refresh();
  };
  window.addEventListener("pagehide", () => {
    observer.disconnect();
    if (scheduled !== undefined) cancelAnimationFrame(scheduled);
    scheduled = undefined;
    window.removeEventListener("scroll", schedule);
    window.removeEventListener("resize", schedule);
  });
  window.addEventListener("pageshow", (event) => {
    if (event.persisted) resume();
  });
  resume();
  return refresh;
}
